/**
 * @file server.js
 * @description The offsite WiPay payment backend for Squarespace — zero
 * dependencies (node:http only), runnable as `node app/server.js`.
 *
 * Why this exists: Squarespace's checkout cannot be extended and its Commerce
 * API cannot mark orders paid (GUIDE.md's platform ceiling). Payment
 * therefore happens on WiPay's hosted page, driven by THIS backend, and
 * Squarespace only ever receives an imported order record that the merchant
 * marks paid by hand. Every step the API *can* automate is automated here;
 * the one step it cannot is surfaced explicitly (manual_mark_paid).
 *
 * Routes:
 *   POST /checkout                      create WiPay Payment Request (amount
 *                                       pinned server-side; BACKEND_TOKEN)
 *   GET  /return                        buyer return; hash verified against
 *                                       the PINNED total, never the redirect
 *   POST /webhook                       HMAC-verified, deduped; success is
 *                                       authoritative and triggers Squarespace
 *                                       order sync
 *   GET  /admin/orders                  all records (BACKEND_TOKEN)
 *   GET  /admin/orders/:reference       one record
 *   POST /admin/orders/:reference/sync  (re)try Squarespace order creation
 *   GET  /admin/reconcile               local vs Squarespace gap report
 *   GET  /health                        liveness
 *
 * Security model (mirrors the shipped WP/Magento/OpenCart/Shopify modules):
 *   - amounts pinned at creation; the browser never supplies an amount;
 *   - buyer return verified with md5(txn + pinned_total + api_key),
 *     constant-time, only after server-side recovery of the pinned value;
 *   - webhooks HMAC-SHA256 over timestamp.raw_body, ±300s, deduped by
 *     X-WiPay-Webhook-Id — success webhook = authoritative;
 *   - BACKEND_TOKEN guards creation + admin routes (fail closed);
 *   - secrets only from the environment (see config.js).
 *
 * Deltas from the shared core (both tested in tests/e2e.mjs):
 *   - the copied wipay-core.js stays byte-identical to the Wix-repo original;
 *     this file overrides payload.origin to 'WaypointSquarespace' and derives
 *     order ids with an 'sq' prefix via the core's own sha256hex, because
 *     core.generateOrderId() hardcodes the Wix branding.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, requireWipayCredentials } from './config.js';
import { createStore } from './store.js';
import {
  buildPaymentRequest, parseCheckoutResponse, paymentEndpoint,
  verifyResponseHash, verifyWebhookSignature,
  isValidTransactionId, isValidCheckoutUrl, sha256hex, formatTotal,
  SANDBOX_ACCOUNT_NUMBER,
} from '../lib/wipay-core.js';
import {
  createOrder as squarespaceCreateOrder,
  listOrders as squarespaceListOrders,
} from './squarespace.js';


const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function timingSafeEqualStr(a, b) {
  const x = String(a); const y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

// Bound per-app from the env createApp() received (see createApp below).
let backendToken = '';

function authorized(req) {
  if (!backendToken) return false; // fail closed: no token configured, no access
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return timingSafeEqualStr(got, backendToken);
}

/** Order id for WiPay: 16 chars, alphanumeric, deterministic, 'sq' branded. */
function wipayOrderId(reference) {
  return 'sq' + sha256hex('squarespace:' + String(reference)).slice(0, 14);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Event-name mapping for webhook payloads. Unknown events are recorded
 *  but change no state — we do not invent semantics for undocumented names. */
function classifyWebhookEvent(body) {
  const name = String(
    (body && (body.event || body.type || body.eventType)) || ''
  ).toLowerCase();
  if (name.includes('success') || name.includes('paid') || name.includes('capture')) return 'success';
  if (name.includes('fail') || name.includes('cancel') || name.includes('expired')) return 'failed';
  if (name.includes('refund')) return 'refund';
  return 'unknown';
}

function extractTransactionId(body) {
  if (!body || typeof body !== 'object') return '';
  const cands = [
    body.transaction_id, body.transactionId,
    body.data && (body.data.transaction_id || body.data.transactionId),
    body.payload && (body.payload.transaction_id || body.payload.transactionId),
  ];
  for (const c of cands) if (isValidTransactionId(c)) return String(c);
  return '';
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export function createApp(env) {
  const cfg = loadConfig(env);
  requireWipayCredentials(cfg);
  backendToken = String((env || process.env).BACKEND_TOKEN || '');
  const store = createStore(cfg.dataDir);

  function paymentUrl() {
    if (cfg.wipay.apiBase) return String(cfg.wipay.apiBase).replace(/\/+$/, '') + '/plugins/payments/request';
    return paymentEndpoint(cfg.wipay.country, cfg.wipay.environment);
  }

  async function callPaymentRequest(payload) {
    const url = paymentUrl();
    if (!url) throw Object.assign(new Error('unsupported_country'), { code: 'unsupported_country' });
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw Object.assign(new Error('WiPay unreachable: ' + (e && e.message ? e.message : e)), { code: 'wipay_unreachable' });
    }
    const text = await res.text();
    return parseCheckoutResponse(res.status, text);
  }

  /** Sync a settled order's record into Squarespace. Idempotent: an existing
   *  squarespace_order_id is returned untouched. Failures are stored on the
   *  record (sync_error) so /admin/reconcile and /admin/orders surface them
   *  and POST .../sync can retry. */
  async function syncToSquarespace(rec) {
    if (!cfg.squarespace.apiKey) {
      store.update(rec.order_reference, (r) => {
        r.sync_error = 'SQUARESPACE_API_KEY not configured';
      });
      return { synced: false, reason: 'not_configured' };
    }
    if (rec.squarespace_order_id) {
      return { synced: true, existing: true, order_id: rec.squarespace_order_id };
    }
    try {
      const created = await squarespaceCreateOrder(cfg.squarespace, {
        reference: rec.order_reference,
        total: Number(rec.pinned_total),
        currency: rec.currency,
        email: rec.email,
        channelName: cfg.squarespace.channelName,
        createdAt: rec.created_at,
        title: rec.title || ('WiPay order ' + rec.order_reference),
      });
      store.update(rec.order_reference, (r) => {
        r.squarespace_order_id = created.id || null;
        r.squarespace_order_number = created.orderNumber || null;
        r.squarespace_payment_state = created.paymentState || null;
        // The documented ceiling: the create response's paymentState will
        // read NOT_CHARGED (or similar) — we could not and did not set PAID.
        r.manual_mark_paid = true;
        r.synced_at = new Date().toISOString();
        r.sync_error = null;
      });
      return { synced: true, order_id: created.id, paymentState: created.paymentState };
    } catch (e) {
      store.update(rec.order_reference, (r) => {
        r.sync_error = String(e && e.message ? e.message : e);
      });
      return { synced: false, reason: e && e.code ? e.code : 'error', error: String(e && e.message ? e.message : e) };
    }
  }

  // -- POST /checkout --------------------------------------------------------
  async function handleCheckout(req, res) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }

    const reference = String(body.reference == null ? '' : body.reference).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(reference)) {
      return json(res, 400, { error: 'reference must be 1-64 chars, alphanumeric with . _ : -' });
    }
    const pinned = formatTotal(body.amount);
    if (pinned === null || !(Number(pinned) > 0)) {
      return json(res, 400, { error: 'amount must be a positive number' });
    }
    const currency = String(body.currency || 'TTD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return json(res, 400, { error: 'currency must be a 3-letter code' });
    if (body.email != null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) {
      return json(res, 400, { error: 'email is invalid' });
    }

    // Idempotency: the same reference returns the original redirect so a
    // retried checkout can never create a second WiPay Payment Request.
    const existing = store.get(reference);
    if (existing) {
      return json(res, 200, {
        reference,
        transaction_id: existing.transaction_id,
        checkout_url: existing.checkout_url,
        status: existing.status,
        idempotent: true,
      });
    }

    const orderId = wipayOrderId(reference);
    const payload = buildPaymentRequest({
      account_number: cfg.wipay.account || SANDBOX_ACCOUNT_NUMBER,
      country: cfg.wipay.country,
      currency,
      environment: cfg.wipay.environment,
      fee_structure: cfg.wipay.feeStructure,
      order_id: orderId,
      return_url: cfg.publicBaseUrl + '/return',
      total: pinned,
      email: body.email == null ? '' : String(body.email),
      prefill: {
        fname: body.first_name, lname: body.last_name,
        city: body.city, phone: body.phone,
      },
    });
    // Core hardcodes WaypointWix branding; relabel for this integration.
    payload.origin = 'WaypointSquarespace';
    // Contract-backed amount pin: WiPay echoes `data` in both the buyer
    // return and the webhook, so callbacks can recover the pinned total even
    // if this process restarted (store is the primary source; echo is backup).
    payload.data = JSON.stringify({ order_id: orderId, reference, total: pinned });

    let parsed;
    try {
      parsed = await callPaymentRequest(payload);
    } catch (e) {
      return json(res, 502, { error: e.code || 'wipay_error', detail: String(e.message) });
    }
    if (parsed.error) {
      return json(res, 502, { error: parsed.error, detail: 'WiPay Payment Request failed' });
    }
    if (!isValidTransactionId(parsed.transaction_id) || !isValidCheckoutUrl(parsed.url)) {
      return json(res, 502, { error: 'invalid_wipay_response' });
    }

    store.put({
      order_reference: reference,
      wipay_order_id: orderId,
      transaction_id: parsed.transaction_id,
      checkout_url: parsed.url,
      pinned_total: pinned,
      currency,
      email: body.email == null ? '' : String(body.email),
      title: body.title == null ? '' : String(body.title).slice(0, 200),
      status: 'pending',
      payment_verified_by: null,
      squarespace_order_id: null,
      squarespace_order_number: null,
      squarespace_payment_state: null,
      manual_mark_paid: false,
      synced_at: null,
      sync_error: null,
      events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    return json(res, 201, {
      reference,
      transaction_id: parsed.transaction_id,
      checkout_url: parsed.url,
      status: 'pending',
    });
  }

  // -- GET /return -----------------------------------------------------------
  function handleReturn(req, res, url) {
    const q = url.searchParams;
    const txn = q.get('transaction_id') || q.get('transactionId') || '';
    const status = String(q.get('status') || '').toLowerCase();
    const hash = q.get('hash') || '';
    const dataEcho = q.get('data') || '';

    const page = (code, title, detail) => html(res, code,
      '<!doctype html><meta charset="utf-8"><title>WiPay</title>' +
      '<body style="font-family:sans-serif;max-width:32em;margin:3em auto">' +
      '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(detail) + '</p></body>');

    if (!isValidTransactionId(txn) || (status !== 'success' && status !== 'failed')) {
      return page(400, 'Incomplete payment return', 'The payment provider returned incomplete information.');
    }
    const rec = store.getByTransaction(txn);
    if (!rec) {
      return page(400, 'Unknown transaction', 'This transaction is not known to this server.');
    }

    if (status === 'failed') {
      store.update(rec.order_reference, (r) => {
        // A failed return only downgrades an order that was never verified —
        // it must not clobber a verified/settled state on a stray redirect.
        if (r.status === 'pending') r.status = 'failed';
        r.events.push({ type: 'return_failed', at: new Date().toISOString() });
      });
      return page(200, 'Payment not completed', 'The payment did not complete. No charge was recorded.');
    }

    // Success path: the hash is REQUIRED and is recomputed over the amount
    // this server pinned at creation — never the buyer-visible total echo.
    if (!hash) {
      return page(400, 'Verification failed', 'No verification hash was returned for this payment.');
    }
    let pinned = rec.pinned_total;
    // Backup recovery: contract-backed data echo (JSON) if the store lost it.
    if (!pinned && dataEcho) {
      try {
        const echo = JSON.parse(dataEcho);
        if (echo && echo.total) pinned = formatTotal(echo.total);
      } catch { /* fall through to rejection below */ }
    }
    if (!pinned || !verifyResponseHash(txn, pinned, cfg.wipay.apiKey, hash)) {
      return page(400, 'Verification failed', 'The payment could not be verified. No order was recorded.');
    }

    store.update(rec.order_reference, (r) => {
      r.status = r.status === 'settled' ? 'settled' : 'return_verified';
      r.payment_verified_by = r.payment_verified_by || 'buyer_return';
      r.events.push({ type: 'return_verified', at: new Date().toISOString() });
    });

    return page(200, 'Payment verified',
      'Thank you — your payment for order ' + rec.order_reference + ' was verified. Your order is now being recorded.');
  }

  // -- POST /webhook ---------------------------------------------------------
  async function handleWebhook(req, res) {
    const secret = cfg.wipay.webhookSecret;
    if (!secret) return json(res, 500, { error: 'webhook_secret_unavailable' });

    const signature = req.headers['x-wipay-webhook-signature'] || '';
    const timestamp = req.headers['x-wipay-webhook-timestamp'] || '';
    const webhookId = String(req.headers['x-wipay-webhook-id'] || '');

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return json(res, e.code === 'body_too_large' ? 413 : 400, { error: e.code || 'bad_body' });
    }

    if (!signature || !timestamp) {
      return json(res, 400, { error: 'missing_webhook_signature_headers' });
    }
    if (!verifyWebhookSignature(raw, timestamp, signature, secret)) {
      return json(res, 401, { error: 'webhook_signature_verification_failed' });
    }

    // Dedupe AFTER signature verification: an attacker must not be able to
    // poison the id space with unsigned deliveries.
    if (webhookId && !store.claimWebhookId(webhookId)) {
      return json(res, 200, { received: true, duplicate: true });
    }

    let body;
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const eventClass = classifyWebhookEvent(body);
    const txn = extractTransactionId(body);
    const rec = txn ? store.getByTransaction(txn) : null;

    if (!rec) {
      // Verified but unmatched (race: webhook before our put, or foreign
      // txn): acknowledge so WiPay stops retrying, record nothing.
      return json(res, 200, { received: true, matched: false });
    }

    let action = 'recorded';
    if (eventClass === 'success') {
      store.update(rec.order_reference, (r) => {
        if (r.status !== 'settled') {
          r.status = 'settled';
          r.payment_verified_by = 'webhook'; // authoritative
        }
        r.events.push({ type: 'webhook_success', webhook_id: webhookId, at: new Date().toISOString() });
      });
      const sync = await syncToSquarespace(store.get(rec.order_reference));
      action = sync.synced ? 'settled_synced' : 'settled_sync_pending';
    } else if (eventClass === 'failed') {
      store.update(rec.order_reference, (r) => {
        // Failure events only downgrade orders that were never verified:
        // a verified return or a settled webhook is never walked back by a
        // late/foreign failure event (it is still recorded as evidence).
        if (r.status === 'pending') r.status = 'failed';
        r.events.push({ type: 'webhook_failed', webhook_id: webhookId, at: new Date().toISOString() });
      });
      action = 'marked_failed';
    } else if (eventClass === 'refund') {
      store.update(rec.order_reference, (r) => {
        r.status = 'refunded';
        r.events.push({ type: 'webhook_refund', webhook_id: webhookId, at: new Date().toISOString() });
      });
      action = 'marked_refunded';
    } else {
      store.update(rec.order_reference, (r) => {
        r.events.push({ type: 'webhook_unclassified', event: String((body && (body.event || body.type)) || '').slice(0, 100), webhook_id: webhookId, at: new Date().toISOString() });
      });
    }
    return json(res, 200, { received: true, matched: true, action });
  }

  // -- admin -----------------------------------------------------------------

  async function handleAdminOrders(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const m = url.pathname.match(/^\/admin\/orders\/([^/]+)$/);
    if (m) {
      const rec = store.get(decodeURIComponent(m[1]));
      if (!rec) return json(res, 404, { error: 'not_found' });
      return json(res, 200, rec);
    }
    return json(res, 200, { orders: store.list() });
  }

  async function handleAdminSync(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const ref = decodeURIComponent(url.pathname.replace(/^\/admin\/orders\//, '').replace(/\/sync$/, ''));
    const rec = store.get(ref);
    if (!rec) return json(res, 404, { error: 'not_found' });
    const verified = rec.status === 'settled' || rec.status === 'return_verified';
    if (!verified) {
      return json(res, 409, {
        error: 'payment_not_verified',
        status: rec.status,
        detail: 'Squarespace order records are only created for verified payments.',
      });
    }
    const result = await syncToSquarespace(store.get(ref));
    return json(res, result.synced ? 200 : 502, { reference: ref, ...result, order: store.get(ref) });
  }

  async function handleReconcile(req, res) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const local = store.list();
    const report = {
      generated_at: new Date().toISOString(),
      local_counts: {
        total: local.length,
        verified: local.filter((r) => r.status === 'settled' || r.status === 'return_verified').length,
        settled: local.filter((r) => r.status === 'settled').length,
        synced: local.filter((r) => r.squarespace_order_id).length,
        sync_errors: local.filter((r) => r.sync_error).length,
        awaiting_manual_mark_paid: local.filter((r) => r.squarespace_order_id && r.squarespace_payment_state !== 'PAID').length,
      },
      squarespace: { configured: !!cfg.squarespace.apiKey },
      // The checklist the merchant actually works from:
      needs_sync: local.filter((r) => (r.status === 'settled' || r.status === 'return_verified') && !r.squarespace_order_id)
        .map((r) => r.order_reference),
      sync_errors: local.filter((r) => r.sync_error)
        .map((r) => ({ reference: r.order_reference, error: r.sync_error })),
      // Orders in Squarespace still not PAID that we consider paid — every
      // one of these needs a manual mark-paid in the Squarespace dashboard.
      needs_mark_paid: [],
      unmatched_squarespace_orders: [],
      squarespace_unreachable: null,
    };

    if (!cfg.squarespace.apiKey) return json(res, 200, report);
    try {
      const { orders: sqOrders } = await squarespaceListOrders(cfg.squarespace, { maxPages: 5 });
      const byRef = new Map();
      for (const o of sqOrders) {
        if (o && o.externalOrderReference) byRef.set(String(o.externalOrderReference), o);
      }
      for (const r of local) {
        const verified = r.status === 'settled' || r.status === 'return_verified';
        const sq = r.squarespace_order_id ? (byRef.get(r.order_reference) || null) : null;
        if (verified && r.squarespace_order_id && sq && sq.paymentState !== 'PAID') {
          report.needs_mark_paid.push({
            reference: r.order_reference,
            squarespace_order_id: r.squarespace_order_id,
            squarespace_payment_state: sq.paymentState,
            wipay_transaction_id: r.transaction_id,
          });
        }
      }
      for (const o of sqOrders) {
        const ref = String(o.externalOrderReference || '');
        if (ref && !store.get(ref)) report.unmatched_squarespace_orders.push({ reference: ref, id: o.id, paymentState: o.paymentState });
      }
      // Cross-check the stored snapshot against the live read too (covers
      // stores created when the list was empty or paginated out).
      for (const r of local) {
        if (r.squarespace_order_id && r.squarespace_payment_state !== 'PAID' &&
            !report.needs_mark_paid.some((x) => x.reference === r.order_reference)) {
          const sq = byRef.get(r.order_reference);
          if (!sq) {
            report.needs_mark_paid.push({
              reference: r.order_reference,
              squarespace_order_id: r.squarespace_order_id,
              squarespace_payment_state: r.squarespace_payment_state || 'UNKNOWN',
              wipay_transaction_id: r.transaction_id,
            });
          }
        }
      }
    } catch (e) {
      report.squarespace_unreachable = String(e && e.message ? e.message : e);
    }
    return json(res, 200, report);
  }

  // -- router ----------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, wipay_environment: cfg.wipay.environment, squarespace_configured: !!cfg.squarespace.apiKey });
      }
      if (req.method === 'POST' && path === '/checkout') return await handleCheckout(req, res);
      if (req.method === 'GET' && path === '/return') return handleReturn(req, res, url);
      if (req.method === 'POST' && path === '/webhook') return await handleWebhook(req, res);
      if (req.method === 'GET' && (path === '/admin/orders' || /^\/admin\/orders\/[^/]+$/.test(path))) {
        return await handleAdminOrders(req, res, url);
      }
      if (req.method === 'POST' && /^\/admin\/orders\/[^/]+\/sync$/.test(path)) {
        return await handleAdminSync(req, res, url);
      }
      if (req.method === 'GET' && path === '/admin/reconcile') return await handleReconcile(req, res);
      return json(res, 404, { error: 'not_found' });
    } catch (e) {
      return json(res, 500, { error: 'server_error', detail: String(e && e.message ? e.message : e) });
    }
  });
  server.__store = store;
  server.__config = cfg;
  return server;
}

// ---------------------------------------------------------------------------
// entry point: node app/server.js
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createApp(process.env);
  server.listen(server.__config.port, () => {
    const c = server.__config;
    console.log('WiPay offsite backend listening on :' + c.port);
    console.log('  environment: ' + c.wipay.environment + '  country: ' + c.wipay.country);
    console.log('  public base: ' + c.publicBaseUrl);
    console.log('  squarespace: ' + (c.squarespace.apiKey ? 'configured' : 'NOT configured (order sync disabled)'));
    console.log('  sandbox credentials in use: ' + (c.wipay.account === SANDBOX_ACCOUNT_NUMBER ? 'yes (1234567890)' : 'custom'));
  });
}
