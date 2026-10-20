/**
 * @file squarespace.js
 * @description Squarespace Commerce API client for the offsite WiPay prototype.
 *
 * Two operations, both shaped exactly from the official docs verified
 * 2026-10-20 (developers.squarespace.com):
 *
 *   createOrder  POST https://api.squarespace.com/1.0/commerce/orders
 *     Required headers: Authorization: Bearer <API key>,
 *     User-Agent (requests without it are rejected), Idempotency-Key
 *     (required for Create Order), Content-Type: application/json.
 *     Required body: channelName (<=30 chars), createdOn, externalOrderReference,
 *     fulfillments (line-items style array; may be empty for unfulfilled),
 *     grandTotal {currency,value}, lineItems (cannot be empty),
 *     priceTaxInterpretation (INCLUSIVE|EXCLUSIVE).
 *     NEVER sends paymentState — it is not an accepted create-request field
 *     (verified: the field list does not include it), which is exactly why
 *     marking paid stays a manual step. Creating the record is automatable;
 *     setting PAID is not.
 *     Idempotency: the same Idempotency-Key returns the original order, so
 *     retries after a network failure cannot double-create. Rate limits:
 *     300/min Commerce-wide, 100/hour per site for create-order with an API key.
 *
 *   getOrder      GET https://api.squarespace.com/1.0/commerce/orders/{id}
 *     Returns the Order at JSON root (id, orderNumber, paymentState,
 *     channelName, externalOrderReference...). Read Only permission suffices.
 *
 *   listOrders    GET https://api.squarespace.com/1.0/commerce/orders
 *     Returns { result: [Order], pagination: { hasNextPage, nextPageCursor,
 *     nextPageUrl } }; up to 50 orders, ordered by modifiedOn, cursor via
 *     ?cursor=. paymentStates filter (default NOT_CHARGED,AUTHORIZED,PAID,
 *     REFUNDED) and modifiedAfter/modifiedBefore are documented.
 *
 * paymentState enum (Orders overview): NOT_CHARGED, AUTHORIZED, PAID,
 * PARTIALLY_PAID, PENDING, FAILED, REFUND_PENDING, REFUNDED, REFUND_FAILED.
 * The Get-order endpoint's own field enum omits PARTIALLY_PAID (docs lag);
 * treat it as valid.
 *
 * Auth: Settings > Advanced > Developer API Keys (Orders Read+Write),
 * Authorization: Bearer <API_KEY>. No IP allowlisting documented.
 *
 * Tests point SQUARESPACE_API_BASE at harness/mock_squarespace.mjs (which
 * enforces these same rules); production never overrides it.
 */

import { DEFAULT_SQUARESPACE_API_BASE } from './config.js';

/** Fails fast on missing/unusable credentials before any request is sent. */
function requireConfig(cfg) {
  if (!cfg || !cfg.apiKey) {
    const err = new Error('SQUARESPACE_API_KEY is not configured — order sync/reconcile disabled.');
    err.code = 'not_configured';
    throw err;
  }
  if (!cfg.userAgent || String(cfg.userAgent).trim() === '') {
    throw new Error('Squarespace rejects requests without a User-Agent header.');
  }
}

function baseOf(cfg) {
  const b = (cfg && cfg.apiBase) || DEFAULT_SQUARESPACE_API_BASE;
  return String(b).replace(/\/+$/, '');
}

function headers(cfg, extra) {
  return Object.assign({
    // Squarespace rejects requests with no User-Agent.
    'User-Agent': cfg.userAgent,
    'Authorization': 'Bearer ' + cfg.apiKey,
    'Accept': 'application/json',
  }, extra || {});
}

async function request(cfg, path, init) {
  requireConfig(cfg);
  const url = baseOf(cfg) + path;
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error('Squarespace API network failure: ' + (e && e.message ? e.message : String(e)));
    err.code = 'network';
    throw err;
  }
  const text = await res.text();
  if (res.status === 429) {
    const err = new Error('Squarespace API rate limited (429). Commerce limit is 300/min; create-order additionally 100/hour per site.');
    err.code = 'rate_limited';
    err.retryAfter = res.headers.get('Retry-After');
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Squarespace API auth rejected (' + res.status + '): ' + text.slice(0, 300));
    err.code = 'auth';
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error('Squarespace API HTTP ' + res.status + ': ' + text.slice(0, 300));
    err.code = 'http_' + res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Squarespace API returned non-JSON body: ' + text.slice(0, 200));
    err.code = 'invalid_json';
    throw err;
  }
}

/**
 * Builds the documented Create Order body for a verified WiPay payment.
 *
 * The record is an imported third-party-channel order: one line item for the
 * full paid amount (this backend does not carry the merchant's catalogue —
 * variantId is optional per docs and omitted), externalOrderReference is the
 * audit key back to this backend's order reference.
 *
 * Input: { reference, total, currency, email?, channelName, createdAt?,
 *           title?, priceTaxInterpretation? }
 *   total  — number, already verified server-side (pinned amount).
 */
export function buildCreateOrderBody(input) {
  const o = input || {};
  const total = Number(o.total);
  if (!isFinite(total) || total <= 0) {
    throw new Error('createOrder: a positive verified total is required.');
  }
  const currency = String(o.currency == null ? '' : o.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('createOrder: currency must be a 3-letter code.');
  }
  const reference = String(o.reference == null ? '' : o.reference).trim();
  if (reference === '') {
    throw new Error('createOrder: externalOrderReference (order reference) is required.');
  }
  const amount = { currency, value: Number(total.toFixed(2)) };

  const body = {
    channelName: String(o.channelName || 'WiPay Offsite').slice(0, 30),
    createdOn: o.createdAt || new Date().toISOString(),
    externalOrderReference: reference,
    customerEmail: String(o.email == null ? '' : o.email),
    lineItems: [{
      lineItemType: 'PHYSICAL_PRODUCT',
      title: String(o.title || ('WiPay order ' + reference)).slice(0, 200),
      quantity: 1,
      unitPricePaid: amount,
    }],
    grandTotal: amount,
    // Unfulfilled by default; fulfilledOn only becomes required once
    // fulfillmentStatus is FULFILLED, which this backend never sets.
    fulfillments: [],
    fulfillmentStatus: 'PENDING',
    priceTaxInterpretation: o.priceTaxInterpretation === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE',
    inventoryBehavior: 'SKIP',
  };
  // Deliberately absent: paymentState / paymentMethodName / paymentStatus —
  // none are accepted create-request fields (verified 2026-10-20). The order
  // lands as NOT_CHARGED and the merchant marks it paid in Squarespace by hand.
  if (!body.customerEmail) delete body.customerEmail;
  return body;
}

/**
 * Creates the Squarespace order record for a verified WiPay payment.
 * Idempotency-Key is derived from the order reference so a retry after a
 * timeout returns the same Squarespace order instead of creating a duplicate.
 * Returns the created Order resource ({id, orderNumber, paymentState, ...}).
 */
export async function createOrder(cfg, input) {
  const body = buildCreateOrderBody(input);
  const idemKey = 'wipay-' + String(input.reference).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  return request(cfg, '/1.0/commerce/orders', {
    method: 'POST',
    headers: headers(cfg, {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    }),
    body: JSON.stringify(body),
  });
}

/** Fetches one order by Squarespace id. Returns the Order at JSON root. */
export async function getOrder(cfg, orderId) {
  const id = String(orderId == null ? '' : orderId);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    throw new Error('getOrder: invalid order id.');
  }
  return request(cfg, '/1.0/commerce/orders/' + encodeURIComponent(id), {
    method: 'GET',
    headers: headers(cfg),
  });
}

/**
 * Lists orders following the documented cursor pagination.
 * opts: { paymentStates?, modifiedAfter?, modifiedBefore?, maxPages? }.
 * Returns { orders: [...], pages } — stops at maxPages (default 5) or when
 * pagination.hasNextPage is false.
 */
export async function listOrders(cfg, opts) {
  const o = opts || {};
  const maxPages = Math.max(1, Math.min(Number(o.maxPages) || 5, 50));
  const orders = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    else {
      if (o.paymentStates) params.set('paymentStates', String(o.paymentStates));
      if (o.modifiedAfter) params.set('modifiedAfter', String(o.modifiedAfter));
      if (o.modifiedBefore) params.set('modifiedBefore', String(o.modifiedBefore));
    }
    const qs = params.toString();
    const page = await request(cfg, '/1.0/commerce/orders' + (qs ? '?' + qs : ''), {
      method: 'GET',
      headers: headers(cfg),
    });
    pages++;
    const batch = Array.isArray(page.result) ? page.result : [];
    orders.push(...batch);
    const nav = page.pagination || {};
    if (!nav.hasNextPage || !nav.nextPageCursor || pages >= maxPages) break;
    cursor = nav.nextPageCursor;
  }
  return { orders, pages };
}
