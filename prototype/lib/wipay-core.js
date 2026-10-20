/**
 * @file wipay-core.js
 * @description Pure, dependency-free WiPay contract core shared by the Velo
 * plugin (WiPay.js / http-functions.js) and the Node test harness.
 *
 * No Node or Wix APIs are used here on purpose: Velo's backend runtime does
 * not expose Node's `crypto`, so MD5 and HMAC-SHA256 are implemented in pure
 * JS. The harness (tests/harness.mjs) cross-checks these implementations
 * against Node's built-in crypto on known vectors and random inputs.
 *
 * This mirrors the proven WaypointWiPayCore.php used by the WordPress /
 * Magento / OpenCart / Shopify modules, so the WiPay contract behaves the
 * same here as in the modules already verified against the live sandbox.
 *
 * Contract sources (verified against the live TT sandbox 2026-10-19):
 *   - Payment Request: POST {base}/plugins/payments/request, field
 *     `account_number` (int), returns 200 JSON {url, message, transaction_id}
 *     when the request carries `Accept: application/json`.
 *   - Buyer return hash: md5(transaction_id + original_total_2dp + api_key).
 *   - Webhooks: HMAC-SHA256 over `timestamp + "." + raw_body`, hex, header
 *     `X-WiPay-Webhook-Signature: sha256=<hex>`, ~5-minute replay window.
 *   - Refund: POST {base}/wapi/transactions/{id}/refund, exactly one of
 *     `Authorization: Bearer` or `X-WAPI-Key`.
 */

export const MODULE_VERSION = '1.0.0';

export const SANDBOX_ACCOUNT_NUMBER = '1234567890';
export const SANDBOX_API_KEY = '123';

/** Valid fee_structure values per the live Payments API (verified 2026-10). */
export const FEE_STRUCTURES = ['customer_pay', 'merchant_absorb', 'split'];

/** Territory hosts, live and sandbox, per the live-verified PHP core. */
export const HOSTS = {
  TT: { live: 'tt.wipayfinancial.com', sandbox: 'ttsb.wipayfinancial.com' },
  JM: { live: 'jm.wipayfinancial.com', sandbox: 'jmsb.wipayfinancial.com' },
  BB: { live: 'bb.wipayfinancial.com', sandbox: 'bbsb.wipayfinancial.com' },
  GY: { live: 'gy.wipayfinancial.com', sandbox: 'gysb.wipayfinancial.com' },
  GD: { live: 'gd.wipayfinancial.com', sandbox: 'gdsb.wipayfinancial.com' },
};

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Length-safe constant-time string compare (JS analogue of PHP hash_equals).
 * JS cannot guarantee true constant-time behaviour, but this avoids the
 * early-exit of `===` on content. Both operands must be strings.
 */
export function timingSafeEqual(a, b) {
  const sA = String(a);
  const sB = String(b);
  if (sA.length !== sB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < sA.length; i++) {
    diff |= sA.charCodeAt(i) ^ sB.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// MD5 (pure JS) — for the buyer-return response hash
// ---------------------------------------------------------------------------

function add32(a, b) { return (a + b) & 0xffffffff; }
function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }

function cmn(q, a, b, x, s, t) {
  return add32(rotl(add32(add32(a, q), add32(x, t)), s), b);
}
function md5ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function md5gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function md5hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function md5ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = md5ff(a, b, c, d, k[0], 7, -680876936); d = md5ff(d, a, b, c, k[1], 12, -389564586);
  c = md5ff(c, d, a, b, k[2], 17, 606105819); b = md5ff(b, c, d, a, k[3], 22, -1044525330);
  a = md5ff(a, b, c, d, k[4], 7, -176418897); d = md5ff(d, a, b, c, k[5], 12, 1200080426);
  c = md5ff(c, d, a, b, k[6], 17, -1473231341); b = md5ff(b, c, d, a, k[7], 22, -45705983);
  a = md5ff(a, b, c, d, k[8], 7, 1770035416); d = md5ff(d, a, b, c, k[9], 12, -1958414417);
  c = md5ff(c, d, a, b, k[10], 17, -42063); b = md5ff(b, c, d, a, k[11], 22, -1990404162);
  a = md5ff(a, b, c, d, k[12], 7, 1804603682); d = md5ff(d, a, b, c, k[13], 12, -40341101);
  c = md5ff(c, d, a, b, k[14], 17, -1502002290); b = md5ff(b, c, d, a, k[15], 22, 1236535329);

  a = md5gg(a, b, c, d, k[1], 5, -165796510); d = md5gg(d, a, b, c, k[6], 9, -1069501632);
  c = md5gg(c, d, a, b, k[11], 14, 643717713); b = md5gg(b, c, d, a, k[0], 20, -373897302);
  a = md5gg(a, b, c, d, k[5], 5, -701558691); d = md5gg(d, a, b, c, k[10], 9, 38016083);
  c = md5gg(c, d, a, b, k[15], 14, -660478335); b = md5gg(b, c, d, a, k[4], 20, -405537848);
  a = md5gg(a, b, c, d, k[9], 5, 568446438); d = md5gg(d, a, b, c, k[14], 9, -1019803690);
  c = md5gg(c, d, a, b, k[3], 14, -187363961); b = md5gg(b, c, d, a, k[8], 20, 1163531501);
  a = md5gg(a, b, c, d, k[13], 5, -1444681467); d = md5gg(d, a, b, c, k[2], 9, -51403784);
  c = md5gg(c, d, a, b, k[7], 14, 1735328473); b = md5gg(b, c, d, a, k[12], 20, -1926607734);

  a = md5hh(a, b, c, d, k[5], 4, -378558); d = md5hh(d, a, b, c, k[8], 11, -2022574463);
  c = md5hh(c, d, a, b, k[11], 16, 1839030562); b = md5hh(b, c, d, a, k[14], 23, -35309556);
  a = md5hh(a, b, c, d, k[1], 4, -1530992060); d = md5hh(d, a, b, c, k[4], 11, 1272893353);
  c = md5hh(c, d, a, b, k[7], 16, -155497632); b = md5hh(b, c, d, a, k[10], 23, -1094730640);
  a = md5hh(a, b, c, d, k[13], 4, 681279174); d = md5hh(d, a, b, c, k[0], 11, -358537222);
  c = md5hh(c, d, a, b, k[3], 16, -722521979); b = md5hh(b, c, d, a, k[6], 23, 76029189);
  a = md5hh(a, b, c, d, k[9], 4, -640364487); d = md5hh(d, a, b, c, k[12], 11, -421815835);
  c = md5hh(c, d, a, b, k[15], 16, 530742520); b = md5hh(b, c, d, a, k[2], 23, -995338651);

  a = md5ii(a, b, c, d, k[0], 6, -198630844); d = md5ii(d, a, b, c, k[7], 10, 1126891415);
  c = md5ii(c, d, a, b, k[14], 15, -1416354905); b = md5ii(b, c, d, a, k[5], 21, -57434055);
  a = md5ii(a, b, c, d, k[12], 6, 1700485571); d = md5ii(d, a, b, c, k[3], 10, -1894986606);
  c = md5ii(c, d, a, b, k[10], 15, -1051523); b = md5ii(b, c, d, a, k[1], 21, -2054922799);
  a = md5ii(a, b, c, d, k[8], 6, 1873313359); d = md5ii(d, a, b, c, k[15], 10, -30611744);
  c = md5ii(c, d, a, b, k[6], 15, -1560198380); b = md5ii(b, c, d, a, k[13], 21, 1309151649);
  a = md5ii(a, b, c, d, k[4], 6, -145523070); d = md5ii(d, a, b, c, k[11], 10, -1120210379);
  c = md5ii(c, d, a, b, k[2], 15, 718787259); b = md5ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
}

function md5blk(s) {
  const blks = [];
  for (let i = 0; i < 64; i += 4) {
    blks[i >> 2] =
      s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
  }
  return blks;
}

const MD5_CHR = '0123456789abcdef';
function md51(s) {
  const n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(s.substring(i - 64, i)));
  }
  s = s.substring(i - 64);
  const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++) {
    tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  }
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}

function rhex(n) {
  let s = '';
  for (let j = 0; j < 4; j++) {
    s += MD5_CHR[(n >> (j * 8 + 4)) & 0x0f] + MD5_CHR[(n >> (j * 8)) & 0x0f];
  }
  return s;
}

/** UTF-8-safe MD5 hex digest (matches PHP md5() / Node crypto md5). */
export function md5(str) {
  const bytes = unescape(encodeURIComponent(String(str)));
  const x = md51(bytes);
  return rhex(x[0]) + rhex(x[1]) + rhex(x[2]) + rhex(x[3]);
}

// ---------------------------------------------------------------------------
// SHA-256 + HMAC-SHA256 (pure JS) — for webhook signature verification
// ---------------------------------------------------------------------------

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(str) {
  const out = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

/** SHA-256 hex digest of a UTF-8 string (matches Node crypto sha256). */
export function sha256hex(str) {
  return sha256Bytes(utf8Bytes(str));
}

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

/**
 * HMAC-SHA256 hex (matches Node crypto createHmac('sha256', key)).
 * Operates on byte arrays throughout; keys/messages are UTF-8 encoded once
 * and never round-tripped through String(), which would mangle bytes >0x7f.
 */
export function hmacSha256Hex(key, message) {
  let k = utf8Bytes(key);
  if (k.length > 64) k = hexToBytes(sha256Bytes(k));
  while (k.length < 64) k.push(0);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  const inner = hexToBytes(sha256Bytes(ipad.concat(utf8Bytes(message))));
  return sha256Bytes(opad.concat(inner));
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

/** SHA-256 over a byte array; returns hex. */
function sha256Bytes(bytes) {
  const msg = bytes.slice();
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit big-endian length; inputs here are far below 2^32 bits.
  for (let i = 7; i >= 0; i--) msg.push(i < 4 ? (bitLen >>> (i * 8)) & 0xff : 0);

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// WiPay contract helpers
// ---------------------------------------------------------------------------

/** Normalizes fee structure to the API's valid values, defaulting safely. */
export function feeStructure(value) {
  const v = String(value == null ? '' : value);
  if (FEE_STRUCTURES.includes(v)) return v;
  const aliases = { MERCHANT: 'merchant_absorb', CUSTOMER: 'customer_pay', SPLIT: 'split' };
  return aliases[v] || 'merchant_absorb';
}

/** True for a plausible WiPay transaction id (SB-... / NN-...). */
export function isValidTransactionId(id) {
  const s = String(id == null ? '' : id);
  return s !== '' && s.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
}

/** True when the URL is an HTTPS wipayfinancial.com URL. */
export function isValidCheckoutUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return /(^|\.)wipayfinancial\.com$/i.test(u.hostname);
}

export function baseUrl(country, environment) {
  const c = String(country == null ? '' : country).toUpperCase();
  const host = HOSTS[c] && HOSTS[c][environment];
  return host ? 'https://' + host : null;
}

export function paymentEndpoint(country, environment) {
  const base = baseUrl(country, environment);
  return base === null ? null : base + '/plugins/payments/request';
}

export function wapiEndpoint(country, environment, path) {
  const base = baseUrl(country, environment);
  return base === null ? null : base + '/wapi' + path;
}

/** 'live'|'sandbox' for a WAPI key (`wapi_{env}_{kid}_{secret}`), null if malformed. */
export function wapiEnvironment(key) {
  const parts = String(key == null ? '' : key).trim().split('_');
  if (parts.length < 2 || parts[0] !== 'wapi') return null;
  if (parts[1] === 'live') return 'live';
  if (parts[1] === 'test') return 'sandbox';
  return null;
}

/**
 * Buyer-return response hash: md5(transaction_id + original_total_2dp + api_key).
 * The total MUST be the original submitted amount formatted to exactly two
 * decimals — never the buyer-facing total echoed in the redirect.
 */
export function responseHash(transactionId, originalTotal, apiKey) {
  return md5(String(transactionId) + formatTotal(originalTotal) + String(apiKey));
}

/** Formats an amount to exactly two decimals, or returns null when unusable. */
export function formatTotal(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return null;
  return n.toFixed(2);
}

/** Constant-time verification of a buyer-return hash. */
export function verifyResponseHash(transactionId, originalTotal, apiKey, providedHash) {
  const given = String(providedHash == null ? '' : providedHash).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(given)) return false;
  return timingSafeEqual(responseHash(transactionId, originalTotal, apiKey), given);
}

/**
 * Verifies a WiPay webhook signature (documented v1 scheme): HMAC-SHA256 over
 * `timestamp + "." + raw_body` with the endpoint secret, constant-time compared
 * against the hex part of X-WiPay-Webhook-Signature, within a ±300s window.
 */
export function verifyWebhookSignature(rawBody, timestamp, signatureHeader, secret, nowSeconds) {
  if (!secret || !rawBody || !timestamp || !signatureHeader) return false;
  if (!/^[0-9]+$/.test(String(timestamp))) return false;
  if (!/^sha256=[a-f0-9]{64}$/.test(String(signatureHeader))) return false;
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  const age = now - Number(timestamp);
  if (age > 300 || age < -300) return false;
  const expected = hmacSha256Hex(String(secret), String(timestamp) + '.' + String(rawBody));
  const received = String(signatureHeader).slice('sha256='.length);
  return timingSafeEqual(expected, received);
}

/**
 * Builds the documented Payment Request payload. The amount comes from the
 * order server-side; the browser/Wix never supplies one.
 *
 * opts keys: total, currency, email, order_id, country, environment,
 * fee_structure, account_number, return_url, data, prefill (assoc of
 * fname/lname/addr1/addr2/city/state/zipcode/country/phone).
 */
export function buildPaymentRequest(opts) {
  const o = opts || {};
  const payload = {
    account_number: Number(o.account_number),
    country_code: String(o.country == null ? '' : o.country).toUpperCase(),
    currency: String(o.currency == null ? '' : o.currency).toUpperCase(),
    environment: String(o.environment == null ? '' : o.environment),
    fee_structure: feeStructure(o.fee_structure),
    method: 'credit_card_co',
    order_id: String(o.order_id == null ? '' : o.order_id),
    origin: 'WaypointWix',
    response_url: String(o.return_url == null ? '' : o.return_url),
    total: formatTotal(o.total),
    email: String(o.email == null ? '' : o.email),
    version: MODULE_VERSION,
    data: JSON.stringify({ order_id: String(o.order_id == null ? '' : o.order_id) }),
  };
  const limits = { fname: 30, lname: 30, addr1: 50, addr2: 50, city: 30, state: 30, zipcode: 10 };
  const prefill = o.prefill && typeof o.prefill === 'object' ? o.prefill : {};
  const hasFname = !!(prefill.fname && String(prefill.fname).trim() !== '');
  const hasAddr1 = !!(prefill.addr1 && String(prefill.addr1).trim() !== '');
  for (const [field, limit] of Object.entries(limits)) {
    if (field === 'lname' && !hasFname) continue;
    if (field === 'addr2' && !hasAddr1) continue;
    if (prefill[field] == null) continue;
    const text = String(prefill[field]).trim();
    if (text !== '') payload[field] = text.slice(0, limit);
  }
  if (prefill.country && /^[A-Za-z]{2}$/.test(String(prefill.country).trim())) {
    payload.country = String(prefill.country).trim().toUpperCase();
  }
  if (prefill.phone != null) {
    const digits = String(prefill.phone).replace(/[^+0-9]/g, '');
    if (/^\+[1-9][0-9]{1,14}$/.test(digits)) payload.phone = digits;
  }
  return payload;
}

/**
 * Parses a Payment Request HTTP response. Returns {url, transaction_id} on a
 * valid 200 JSON response, or {error} — mirrors the proven PHP validation so a
 * failed/odd response is never treated as a checkout URL.
 */
export function parseCheckoutResponse(status, bodyText) {
  if (Number(status) !== 200) return { error: 'http_' + status };
  let data;
  try { data = JSON.parse(bodyText); } catch { return { error: 'invalid_json' }; }
  const url = data && typeof data.url === 'string' ? data.url.trim() : '';
  const txn = data && typeof data.transaction_id === 'string' ? data.transaction_id.trim() : '';
  if (!isValidCheckoutUrl(url) || !isValidTransactionId(txn)) {
    return { error: 'invalid_wipay_response' };
  }
  return { url, transaction_id: txn };
}

/**
 * Generates a WiPay order_id from a Wix order/transaction reference: 16 chars,
 * alphanumeric, no leading/trailing separator (per the documented order_id
 * rules). Deterministic for a given input so retries reuse the same id.
 */
export function generateOrderId(source) {
  const raw = String(source == null ? '' : source);
  const digest = sha256hex('wix:' + raw);
  return ('wix' + digest.slice(0, 13));
}
