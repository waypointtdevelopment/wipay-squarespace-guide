/**
 * @file tests/e2e.mjs
 * @description End-to-end suite for the offsite WiPay backend for Squarespace.
 *
 * Every assertion runs over REAL HTTP: the app server, mock_wipay and
 * mock_squarespace are three separate node:http servers on ephemeral ports.
 * The mock Squarespace enforces the documented API contract (auth, required
 * headers/fields, no paymentState at create, idempotency), so our client is
 * tested against the rules rather than a permissive stub. The WiPay side's
 * crypto (response hash, webhook HMAC) runs through the real wipay-core.js
 * copy — the only fake is the Payment Request endpoint's response.
 *
 * What this proves, in order:
 *   1.  core copy: pure-JS md5/sha256/hmac match Node's crypto (randomized)
 *   2.  server boots with required credentials; health endpoint reports env
 *   3.  admin routes refuse missing/incorrect BACKEND_TOKEN (fail closed)
 *   4.  checkout validation (reference, amount, currency, email)
 *   5.  checkout happy path: correct WiPay payload field names, amount
 *       pinned server-side, origin relabelled, data echo carries the pin
 *   6.  checkout idempotency: same reference -> same transaction, one request
 *   7.  checkout failure path: WiPay 5xx -> 502, nothing stored
 *   8.  buyer return: hash verified ONLY against the pinned amount; tampered
 *       hash, wrong-amount hash, missing hash, unknown txn all rejected;
 *       verified return flips status without settling
 *   9.  webhook: bad signature 401, stale timestamp 401, unsigned 400,
 *       duplicate id -> deduped, success -> settled + AUTO Squarespace sync,
 *       failure event never downgrades a settled order
 *   10. Squarespace create-order contract enforced by the mock (required
 *       fields, User-Agent, Idempotency-Key, NO paymentState), response lands
 *       as NOT_CHARGED with manual_mark_paid=true — the platform ceiling,
 *       asserted from the running server
 *   11. sync retry: create failure stored, POST .../sync retries, replay
 *       returns existing order (idempotent, exactly one Squarespace order)
 *   12. sync gating: unverified payment -> 409, never creates a record
 *   13. reconcile report: needs_sync / needs_mark_paid / counts / auth
 *   14. store durability: pinned totals survive a server restart
 *   15. optional LIVE sandbox probe (WIPAY_SANDBOX_LIVE=1): one real
 *       Payment Request against ttsb.wipayfinancial.com
 *
 * Run: node tests/e2e.mjs     (exit code 0 = all pass)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockWiPay } from '../harness/mock_wipay.mjs';
import { startMockSquarespace } from '../harness/mock_squarespace.mjs';
import { createApp } from '../app/server.js';
import {
  md5, sha256hex, hmacSha256Hex,
  SANDBOX_ACCOUNT_NUMBER, SANDBOX_API_KEY, paymentEndpoint,
} from '../lib/wipay-core.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const BACKEND_TOKEN = 'test-backend-token-123';
const WEBHOOK_SECRET = 'whsec_test_456';
const API_KEY = SANDBOX_API_KEY; // sandbox hash key "123", as in the docs
const WIPAY_ACCOUNT = SANDBOX_ACCOUNT_NUMBER;

async function main() {
  // -------------------------------------------------------------------------
  section('1. core copy: pure-JS crypto vs Node built-in');
  // -------------------------------------------------------------------------
  const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join('');
  let md5Ok = true; let shaOk = true; let hmacOk = true;
  for (let i = 0; i < 300; i++) {
    const s = rnd(1 + Math.floor(Math.random() * 200));
    if (md5(s) !== crypto.createHash('md5').update(s, 'utf8').digest('hex')) { md5Ok = false; break; }
    if (sha256hex(s) !== crypto.createHash('sha256').update(s, 'utf8').digest('hex')) { shaOk = false; break; }
  }
  for (let i = 0; i < 200; i++) {
    const k = rnd(1 + Math.floor(Math.random() * 120)); // includes >64B key path
    const m = rnd(1 + Math.floor(Math.random() * 200));
    if (hmacSha256Hex(k, m) !== crypto.createHmac('sha256', k).update(m, 'utf8').digest('hex')) { hmacOk = false; break; }
  }
  check('md5 matches Node crypto (300 random)', md5Ok);
  check('sha256 matches Node crypto (300 random)', shaOk);
  check('hmac-sha256 matches Node crypto (200 pairs, long keys)', hmacOk);
  check('md5("abc") RFC vector', md5('abc') === '900150983cd24fb0d6963f7d28e17f72');
  check('sha256("abc") NIST vector', sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // -------------------------------------------------------------------------
  section('2. boot: mocks + app server over real HTTP');
  // -------------------------------------------------------------------------
  const mockWiPay = await startMockWiPay();
  const mockSq = await startMockSquarespace();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipay-sqsp-e2e-'));
  const env = {
    PORT: '0',
    PUBLIC_BASE_URL: 'https://pay.example.test',
    DATA_DIR: dataDir,
    BACKEND_TOKEN,
    WIPAY_ACCOUNT,
    WIPAY_API_KEY: API_KEY,
    WIPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    WIPAY_COUNTRY: 'TT',
    WIPAY_ENVIRONMENT: 'sandbox',
    WIPAY_API_BASE: mockWiPay.baseUrl,
    SQUARESPACE_API_KEY: 'sqsp_test_key',
    SQUARESPACE_API_BASE: mockSq.baseUrl,
    SQUARESPACE_USER_AGENT: 'Waypoint-WiPay-Squarespace-Prototype/1.0',
  };

  const app = createApp(env);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const auth = { Authorization: 'Bearer ' + BACKEND_TOKEN };

  const health = await (await fetch(base + '/health')).json();
  check('health ok', health.ok === true, JSON.stringify(health));
  check('health reports sandbox environment', health.wipay_environment === 'sandbox');
  check('health reports squarespace configured', health.squarespace_configured === true);

  // -------------------------------------------------------------------------
  section('3. auth: admin and checkout refuse without token (fail closed)');
  // -------------------------------------------------------------------------
  const noTokCheckout = await fetch(base + '/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: 'R1', amount: 10 }),
  });
  check('checkout without token -> 401', noTokCheckout.status === 401);
  const badTok = await fetch(base + '/admin/orders', { headers: { Authorization: 'Bearer wrong' } });
  check('admin with wrong token -> 401', badTok.status === 401);
  const noTokAdmin = await fetch(base + '/admin/reconcile');
  check('reconcile without token -> 401', noTokAdmin.status === 401);
  const noTokSync = await fetch(base + '/admin/orders/R1/sync', { method: 'POST' });
  check('sync without token -> 401', noTokSync.status === 401);

  // -------------------------------------------------------------------------
  section('4. checkout validation');
  // -------------------------------------------------------------------------
  async function checkout(body, headers) {
    const r = await fetch(base + '/checkout', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || auth),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  let r = await checkout({ reference: 'bad reference!', amount: 10 });
  check('invalid reference -> 400', r.status === 400, JSON.stringify(r.json));
  r = await checkout({ reference: 'R1', amount: 0 });
  check('zero amount -> 400', r.status === 400);
  r = await checkout({ reference: 'R1', amount: -5 });
  check('negative amount -> 400', r.status === 400);
  r = await checkout({ reference: 'R1', amount: 'abc' });
  check('non-numeric amount -> 400', r.status === 400);
  r = await checkout({ reference: 'R1', amount: 10, currency: 'DOLLARS' });
  check('bad currency -> 400', r.status === 400);
  r = await checkout({ reference: 'R1', amount: 10, email: 'not-an-email' });
  check('bad email -> 400', r.status === 400);
  r = await checkout('{not json', auth);
  check('malformed JSON -> 400', r.status === 400);

  // -------------------------------------------------------------------------
  section('5. checkout happy path (payload contract + pinned amount)');
  // -------------------------------------------------------------------------
  const REQ_COUNT_BEFORE = mockWiPay.requests.length;
  r = await checkout({
    reference: 'SQSP-1001', amount: 25, currency: 'ttd',
    email: 'buyer@example.com', first_name: 'Ana', city: 'Port of Spain',
  });
  check('checkout -> 201', r.status === 201, JSON.stringify(r.json));
  check('returns transaction_id', !!(r.json && r.json.transaction_id), JSON.stringify(r.json));
  check('returns checkout_url on wipayfinancial.com', !!(r.json && /^https:\/\/[a-z]+b?\.wipayfinancial\.com\//.test(r.json.checkout_url)), r.json && r.json.checkout_url);
  check('status pending after checkout', r.json && r.json.status === 'pending');

  check('one Payment Request sent to WiPay', mockWiPay.requests.length === REQ_COUNT_BEFORE + 1);
  const sent = mockWiPay.requests[mockWiPay.requests.length - 1].payload;
  check('account_number field (number 1234567890)', sent.account_number === Number(WIPAY_ACCOUNT), JSON.stringify(sent.account_number));
  check('no "account" key', sent.account === undefined);
  check('country_code uppercased TT', sent.country_code === 'TT');
  check('currency uppercased TTD', sent.currency === 'TTD');
  check('method credit_card_co', sent.method === 'credit_card_co');
  check('fee_structure merchant_absorb', sent.fee_structure === 'merchant_absorb');
  check('total pinned as 2-decimal string', sent.total === '25.00', sent.total);
  check('response_url is our /return', sent.response_url === 'https://pay.example.test/return', sent.response_url);
  check('origin relabelled WaypointSquarespace', sent.origin === 'WaypointSquarespace', sent.origin);
  check('order_id <=16 alphanumeric', /^[A-Za-z0-9]{1,16}$/.test(sent.order_id || ''), sent.order_id);
  check('order_id starts sq', /^sq/.test(sent.order_id || ''));
  check('data echo carries pinned total', (() => {
    try { const d = JSON.parse(sent.data); return d.total === '25.00' && d.reference === 'SQSP-1001'; } catch { return false; }
  })(), sent.data);
  check('Accept: application/json header (real endpoint 302s without it)',
    (mockWiPay.requests[mockWiPay.requests.length - 1].headers.accept || '').includes('application/json'));
  check('prefill fname passed through', sent.fname === 'Ana', sent.fname);

  const stored = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('store holds pinned_total 25.00', stored.pinned_total === '25.00', stored.pinned_total);
  check('store holds transaction_id', stored.transaction_id === r.json.transaction_id);

  // -------------------------------------------------------------------------
  section('6. checkout idempotency');
  // -------------------------------------------------------------------------
  const reqsBefore = mockWiPay.requests.length;
  const again = await checkout({ reference: 'SQSP-1001', amount: 25, currency: 'ttd' });
  check('same reference -> 200 (not a duplicate create)', again.status === 200, JSON.stringify(again.json));
  check('same transaction_id returned', again.json && again.json.transaction_id === r.json.transaction_id);
  check('idempotent flag set', again.json && again.json.idempotent === true);
  check('no second Payment Request sent', mockWiPay.requests.length === reqsBefore);

  // -------------------------------------------------------------------------
  section('7. checkout failure path (WiPay 5xx)');
  // -------------------------------------------------------------------------
  mockWiPay.failNext(502);
  r = await checkout({ reference: 'SQSP-FAIL', amount: 10 });
  check('WiPay 502 -> 502 to caller', r.status === 502, JSON.stringify(r.json));
  check('error surfaced as http_502', r.json && r.json.error === 'http_502', JSON.stringify(r.json));
  const afterFail = await fetch(base + '/admin/orders/SQSP-FAIL', { headers: auth });
  check('failed checkout stores no record', afterFail.status === 404);

  // -------------------------------------------------------------------------
  section('8. buyer return: hash verified ONLY against the pinned amount');
  // -------------------------------------------------------------------------
  const txn = (await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json()).transaction_id;
  const goodHash = md5(txn + '25.00' + API_KEY);

  async function ret(query) {
    const u = new URL(base + '/return');
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const res = await fetch(u);
    return { status: res.status, body: await res.text() };
  }

  let rr = await ret({ transaction_id: 'SB-NOPE-1', status: 'success', hash: goodHash });
  check('unknown transaction -> 400', rr.status === 400);
  rr = await ret({ transaction_id: txn, status: 'success' });
  check('success without hash -> 400', rr.status === 400);
  rr = await ret({ transaction_id: txn, status: 'success', hash: 'a'.repeat(32) });
  check('tampered hash -> 400', rr.status === 400);
  rr = await ret({ transaction_id: txn, status: 'success', hash: md5(txn + '0.01' + API_KEY) });
  check('hash over WRONG amount (0.01) -> 400 (pinned rule)', rr.status === 400);
  rr = await ret({ transaction_id: txn, status: 'success', hash: md5(txn + '999.00' + API_KEY) });
  check('hash over inflated amount -> 400', rr.status === 400);
  rr = await ret({ transaction_id: txn, status: 'weird', hash: goodHash });
  check('unrecognized status -> 400', rr.status === 400);

  rr = await ret({ transaction_id: txn, status: 'success', hash: goodHash });
  check('correct hash over pinned total -> 200', rr.status === 200, String(rr.status));
  check('page says verified', /verified/i.test(rr.body));

  let rec = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('verified return does NOT settle (webhook is authoritative)', rec.status === 'return_verified', rec.status);
  check('verified_by recorded as buyer_return', rec.payment_verified_by === 'buyer_return');

  rr = await ret({ transaction_id: txn, status: 'failed' });
  check('failed return after verified -> 200 page', rr.status === 200);
  rec = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('failed return does NOT downgrade verified status', rec.status === 'return_verified', rec.status);

  // -------------------------------------------------------------------------
  section('9. webhook: signature, replay window, dedupe, authority');
  // -------------------------------------------------------------------------
  async function webhook(bodyObj, opts) {
    const o = opts || {};
    const raw = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const ts = o.timestamp || Math.floor(Date.now() / 1000);
    const sig = 'sha256=' + hmacSha256Hex(o.secret || WEBHOOK_SECRET, ts + '.' + raw);
    const headers = { 'Content-Type': 'application/json' };
    if (!o.unsigned) headers['X-WiPay-Webhook-Signature'] = o.badSig || sig;
    if (!o.noTimestamp) headers['X-WiPay-Webhook-Timestamp'] = String(ts);
    if (o.webhookId !== undefined) headers['X-WiPay-Webhook-Id'] = o.webhookId;
    const res = await fetch(base + '/webhook', { method: 'POST', headers, body: raw });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  let wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { unsigned: true });
  check('unsigned webhook -> 400', wr.status === 400, JSON.stringify(wr.json));
  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { badSig: 'sha256=' + '0'.repeat(64) });
  check('bad signature -> 401', wr.status === 401);
  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { secret: 'wrong-secret' });
  check('wrong secret -> 401', wr.status === 401);
  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { timestamp: Math.floor(Date.now() / 1000) - 400 });
  check('stale timestamp (>300s) -> 401', wr.status === 401);
  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { timestamp: Math.floor(Date.now() / 1000) + 400 });
  check('future timestamp (>300s) -> 401', wr.status === 401);

  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { webhookId: 'whk-1' });
  check('valid success webhook -> 200', wr.status === 200, JSON.stringify(wr.json));
  check('action reports synced', wr.json && wr.json.action === 'settled_synced', JSON.stringify(wr.json));

  rec = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('webhook settles the order', rec.status === 'settled', rec.status);
  check('verified_by upgraded to webhook (authoritative)', rec.payment_verified_by === 'webhook');

  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn } }, { webhookId: 'whk-1' });
  check('same webhook id -> duplicate:true', wr.json && wr.json.duplicate === true, JSON.stringify(wr.json));
  rec = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('duplicate delivery recorded exactly once',
    (rec.events || []).filter((e) => e.type === 'webhook_success').length === 1,
    String((rec.events || []).filter((e) => e.type === 'webhook_success').length));

  wr = await webhook({ event: 'payment.failed', data: { transaction_id: txn } }, { webhookId: 'whk-2' });
  check('failure webhook after settle -> 200 ack', wr.status === 200);
  rec = await (await fetch(base + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('failure event NEVER downgrades settled', rec.status === 'settled', rec.status);

  wr = await webhook({ event: 'payment.success', data: { transaction_id: 'SB-FOREIGN-99' } }, { webhookId: 'whk-3' });
  check('verified webhook for unknown txn -> ack, unmatched', wr.status === 200 && wr.json && wr.json.matched === false, JSON.stringify(wr.json));

  // -------------------------------------------------------------------------
  section('10. Squarespace order sync (documented contract, enforced by mock)');
  // -------------------------------------------------------------------------
  check('exactly one Squarespace create call so far', mockSq.createCalls.length === 1, String(mockSq.createCalls.length));
  const create = mockSq.createCalls[0];
  check('Idempotency-Key sent', !!create && !!create.key, JSON.stringify(create && create.key));
  check('externalOrderReference = order reference', create && create.body.externalOrderReference === 'SQSP-1001');
  check('channelName present <=30', create && typeof create.body.channelName === 'string' && create.body.channelName.length <= 30);
  check('createdOn present', create && !!create.body.createdOn);
  check('grandTotal has currency+value', create && create.body.grandTotal && create.body.grandTotal.currency === 'TTD' && create.body.grandTotal.value === 25, JSON.stringify(create && create.body.grandTotal));
  check('lineItems non-empty with unitPricePaid', create && Array.isArray(create.body.lineItems) && create.body.lineItems.length > 0 && create.body.lineItems[0].unitPricePaid.value === 25);
  check('priceTaxInterpretation EXCLUSIVE', create && create.body.priceTaxInterpretation === 'EXCLUSIVE');
  check('fulfillments field present', create && Array.isArray(create.body.fulfillments));
  check('NO paymentState in create body (not an accepted field)', create && !('paymentState' in create.body));
  check('NO paymentMethodName in create body', create && !('paymentMethodName' in create.body));

  check('stored squarespace_order_id', !!(rec.squarespace_order_id), String(rec.squarespace_order_id));
  check('stored squarespace orderNumber', !!(rec.squarespace_order_number));
  check('paymentState as created: NOT_CHARGED', rec.squarespace_payment_state === 'NOT_CHARGED', rec.squarespace_payment_state);
  check('manual_mark_paid = true (platform ceiling)', rec.manual_mark_paid === true);
  check('sync_error clear', rec.sync_error === null);

  const sqOrder = await (await fetch(mockSq.baseUrl + '/1.0/commerce/orders/' + rec.squarespace_order_id, {
    headers: { Authorization: 'Bearer sqsp_test_key', 'User-Agent': 'test' },
  })).json();
  check('Squarespace GET order -> NOT_CHARGED (readback)', sqOrder.paymentState === 'NOT_CHARGED', sqOrder.paymentState);

  // -------------------------------------------------------------------------
  section('11. sync gating + retry + idempotent replay');
  // -------------------------------------------------------------------------
  // Unverified payment can never create a Squarespace record.
  r = await checkout({ reference: 'SQSP-2002', amount: 40, currency: 'ttd' });
  check('second checkout -> 201', r.status === 201, JSON.stringify(r.json));
  const txn2 = r.json.transaction_id;
  const syncEarly = await fetch(base + '/admin/orders/SQSP-2002/sync', { method: 'POST', headers: auth });
  check('sync of UNVERIFIED payment -> 409', syncEarly.status === 409, String(syncEarly.status));
  const earlyOrder = await fetch(mockSq.baseUrl + '/1.0/commerce/orders', { headers: { Authorization: 'Bearer sqsp_test_key', 'User-Agent': 't' } });
  const earlyList = await earlyOrder.json();
  check('no Squarespace order created for unverified payment', earlyList.result.length === 1, String(earlyList.result.length));

  // Simulate Squarespace being unreachable during the success webhook.
  mockSq.failWith429();
  wr = await webhook({ event: 'payment.success', data: { transaction_id: txn2 } }, { webhookId: 'whk-4' });
  check('webhook still 200 when Squarespace is rate-limited', wr.status === 200, JSON.stringify(wr.json));
  check('action = settled_sync_pending', wr.json && wr.json.action === 'settled_sync_pending', JSON.stringify(wr.json));
  rec = await (await fetch(base + '/admin/orders/SQSP-2002', { headers: auth })).json();
  check('order still settles despite sync failure', rec.status === 'settled', rec.status);
  check('sync_error stored for retry', !!rec.sync_error && /rate limited/i.test(rec.sync_error), String(rec.sync_error));

  const retry = await (await fetch(base + '/admin/orders/SQSP-2002/sync', { method: 'POST', headers: auth })).json();
  check('manual sync retry succeeds', retry.synced === true, JSON.stringify(retry));
  check('retry stored squarespace_order_id', !!(retry.order && retry.order.squarespace_order_id));
  check('retry cleared sync_error', retry.order.sync_error === null);

  const replay = await (await fetch(base + '/admin/orders/SQSP-2002/sync', { method: 'POST', headers: auth })).json();
  check('sync replay -> existing (idempotent)', replay.existing === true, JSON.stringify(replay));
  const listNow = await (await fetch(mockSq.baseUrl + '/1.0/commerce/orders', { headers: { Authorization: 'Bearer sqsp_test_key', 'User-Agent': 't' } })).json();
  check('still exactly two Squarespace orders (no duplicates)', listNow.result.length === 2, String(listNow.result.length));

  // -------------------------------------------------------------------------
  section('12. reconcile report');
  // -------------------------------------------------------------------------
  const rep = await (await fetch(base + '/admin/reconcile', { headers: auth })).json();
  check('report generated', !!rep.generated_at);
  check('squarespace configured flag', rep.squarespace && rep.squarespace.configured === true);
  check('counts: total 2', rep.local_counts && rep.local_counts.total === 2, JSON.stringify(rep.local_counts));
  check('counts: settled 2', rep.local_counts && rep.local_counts.settled === 2);
  check('counts: synced 2', rep.local_counts && rep.local_counts.synced === 2);
  check('needs_sync empty after retries', Array.isArray(rep.needs_sync) && rep.needs_sync.length === 0, JSON.stringify(rep.needs_sync));
  check('needs_mark_paid lists both orders (NOT_CHARGED)',
    Array.isArray(rep.needs_mark_paid) && rep.needs_mark_paid.length === 2 &&
    rep.needs_mark_paid.every((x) => x.squarespace_payment_state !== 'PAID' && x.wipay_transaction_id),
    JSON.stringify(rep.needs_mark_paid));
  check('needs_mark_paid carries wipay transaction ids (audit trail)',
    rep.needs_mark_paid.some((x) => x.wipay_transaction_id === txn));
  check('squarespace not unreachable', rep.squarespace_unreachable === null, String(rep.squarespace_unreachable));
  check('no unmatched squarespace orders', Array.isArray(rep.unmatched_squarespace_orders) && rep.unmatched_squarespace_orders.length === 0, JSON.stringify(rep.unmatched_squarespace_orders));

  // -------------------------------------------------------------------------
  section('13. store durability across restart');
  // -------------------------------------------------------------------------
  await new Promise((resolve) => app.close(resolve));
  const app2 = createApp(env);
  await new Promise((resolve) => app2.listen(0, '127.0.0.1', resolve));
  const base2 = 'http://127.0.0.1:' + app2.address().port;
  const rec2 = await (await fetch(base2 + '/admin/orders/SQSP-1001', { headers: auth })).json();
  check('pinned_total survives restart', rec2.pinned_total === '25.00', rec2.pinned_total);
  check('settled status survives restart', rec2.status === 'settled', rec2.status);
  check('squarespace linkage survives restart', !!rec2.squarespace_order_id && !!rec2.squarespace_order_number, String(rec2.squarespace_order_id));

  // Hash verification still works after restart (pinned total persisted):
  const rr2 = await (async () => {
    const u = new URL(base2 + '/return');
    u.searchParams.set('transaction_id', txn);
    u.searchParams.set('status', 'success');
    u.searchParams.set('hash', md5(txn + '25.00' + API_KEY));
    const res = await fetch(u);
    return res.status;
  })();
  check('return hash verifies after restart', rr2 === 200, String(rr2));

  // -------------------------------------------------------------------------
  section('14. entry point + config guard rails');
  // -------------------------------------------------------------------------
  // Missing PUBLIC_BASE_URL must refuse to boot rather than build a broken
  // response_url. Spawn is overkill; loadConfig throws synchronously.
  const { loadConfig } = await import('../app/config.js');
  let threw = false;
  try { loadConfig({ WIPAY_ACCOUNT: '1', WIPAY_API_KEY: '2', WIPAY_WEBHOOK_SECRET: '3' }); } catch { threw = true; }
  check('loadConfig refuses missing PUBLIC_BASE_URL', threw);
  let threwCreds = false;
  const { createApp: ca2 } = { createApp };
  try { ca2({ PUBLIC_BASE_URL: 'https://x.test' }); } catch { threwCreds = true; }
  check('createApp refuses missing WIPAY credentials', threwCreds);

  // -------------------------------------------------------------------------
  section('15. LIVE sandbox probe (optional: WIPAY_SANDBOX_LIVE=1)');
  // -------------------------------------------------------------------------
  if (process.env.WIPAY_SANDBOX_LIVE === '1') {
    try {
      const endpoint = paymentEndpoint('TT', 'sandbox');
      const payload = {
        account_number: Number(WIPAY_ACCOUNT), country_code: 'TT', currency: 'TTD',
        environment: 'sandbox', fee_structure: 'merchant_absorb', method: 'credit_card_co',
        order_id: 'sqsplive' + Date.now().toString(36).slice(-7), origin: 'WaypointSquarespace',
        response_url: 'https://pay.example.test/return', total: '10.00',
        email: 'live-probe@example.com', version: '1.0.0', data: '{}',
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      check('live sandbox 200', res.status === 200, 'status=' + res.status + ' body=' + text.slice(0, 160));
      const parsed = JSON.parse(text);
      check('live sandbox returned wipayfinancial URL', /^https:\/\/[a-z]+b?\.wipayfinancial\.com\//.test(parsed.url || ''), String(parsed.url));
      check('live sandbox returned transaction_id', !!(parsed.transaction_id && parsed.transaction_id.length > 3), String(parsed.transaction_id));
    } catch (e) {
      check('live sandbox probe ran', false, String(e && e.message ? e.message : e));
    }
  } else {
    console.log('  skip  live sandbox probe (set WIPAY_SANDBOX_LIVE=1 to run against ttsb.wipayfinancial.com)');
  }

  // -------------------------------------------------------------------------
  await new Promise((resolve) => app2.close(resolve));
  await mockWiPay.close();
  await mockSq.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('\n== RESULT ==');
  console.log('passed: ' + passed + '   failed: ' + failed);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
