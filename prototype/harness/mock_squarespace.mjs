/**
 * @file mock_squarespace.mjs
 * @description Impersonates the Squarespace Commerce API for the e2e suite.
 *
 * Implements the three endpoints the backend uses, with the documented
 * contracts verified from developers.squarespace.com (2026-10-20):
 *
 *   POST /1.0/commerce/orders       Create Order
 *   GET  /1.0/commerce/orders       List orders (cursor pagination)
 *   GET  /1.0/commerce/orders/:id   Get order
 *
 * The mock ENFORCES the documented rules so a regression in our client fails
 * the suite rather than passing silently:
 *   - 401 without `Authorization: Bearer ...`
 *   - 400 without a User-Agent header (Squarespace rejects such requests)
 *   - 400 without Idempotency-Key on create
 *   - 400 on a create body missing a required field (channelName, createdOn,
 *     externalOrderReference, fulfillments, grandTotal, lineItems non-empty,
 *     priceTaxInterpretation) or with priceTaxInterpretation outside
 *     INCLUSIVE|EXCLUSIVE
 *   - 400 if the body contains paymentState — it is NOT an accepted
 *     create-request field, so sending it would be a contract violation
 *   - Idempotent replay: same Idempotency-Key returns the first-created order
 *   - Rate limit simulation via failWith429()
 *
 * Created orders land exactly as Squarespace would: with a generated id,
 * orderNumber, and paymentState NOT_CHARGED — the mock never marks anything
 * PAID because the API cannot.
 */

import crypto from 'node:crypto';
import http from 'node:http';

const REQUIRED_CREATE_FIELDS = [
  'channelName', 'createdOn', 'externalOrderReference',
  'fulfillments', 'grandTotal', 'lineItems', 'priceTaxInterpretation',
];

export function startMockSquarespace() {
  const orders = [];
  const createCalls = [];
  const idempotency = new Map(); // key -> order index
  let idCounter = 0;
  let rateLimitNext = false;

  function findOrder(id) {
    return orders.find((o) => o.id === id) || null;
  }

  function listResponse(query) {
    // Cursor pagination over a snapshot; up to 50 per page per docs.
    let start = 0;
    const cursor = query.get('cursor');
    if (cursor) {
      const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (Number.isFinite(n)) start = n;
    }
    const page = orders.slice(start, start + 50);
    const next = start + page.length;
    const hasNext = next < orders.length;
    return {
      result: page,
      pagination: {
        hasNextPage: hasNext,
        nextPageCursor: hasNext ? Buffer.from(String(next), 'utf8').toString('base64url') : null,
        nextPageUrl: null,
      },
    };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (rateLimitNext) {
      rateLimitNext = false;
      return send(429, { message: 'rate limited' });
    }

    // Auth: every endpoint requires Bearer.
    const auth = req.headers['authorization'] || '';
    if (!/^Bearer\s+\S+$/.test(auth)) return send(401, { message: 'unauthorized' });
    // Squarespace rejects requests with no User-Agent.
    if (!req.headers['user-agent']) return send(400, { message: 'User-Agent header is required' });

    const bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bodyChunks).toString('utf8');

      // ---- Create Order ----
      if (req.method === 'POST' && url.pathname === '/1.0/commerce/orders') {
        if (!req.headers['idempotency-key']) {
          return send(400, { message: 'Idempotency-Key header is required for Create Order' });
        }
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(400, { message: 'invalid json' }); }

        const missing = REQUIRED_CREATE_FIELDS.filter((f) => body[f] === undefined);
        if (missing.length) return send(400, { message: 'missing required fields: ' + missing.join(', ') });
        if (Object.prototype.hasOwnProperty.call(body, 'paymentState')) {
          // Contract tripwire: paymentState is not an accepted create field.
          return send(400, { message: 'paymentState is not a valid create-order field' });
        }
        if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
          return send(400, { message: 'lineItems cannot be empty' });
        }
        if (!['INCLUSIVE', 'EXCLUSIVE'].includes(body.priceTaxInterpretation)) {
          return send(400, { message: 'priceTaxInterpretation must be INCLUSIVE or EXCLUSIVE' });
        }
        if (String(body.channelName).length > 30) {
          return send(400, { message: 'channelName max 30 chars' });
        }

        const key = String(req.headers['idempotency-key']);
        createCalls.push({ key, body });
        if (idempotency.has(key)) {
          // Documented idempotency behaviour: replay returns the original.
          return send(200, orders[idempotency.get(key)]);
        }

        idCounter += 1;
        const order = {
          id: 'sqorder-' + crypto.randomUUID(),
          orderNumber: String(1000 + idCounter),
          channel: 'web',
          channelName: body.channelName,
          externalOrderReference: body.externalOrderReference,
          // Not settable at create (verified) — always NOT_CHARGED.
          paymentState: 'NOT_CHARGED',
          fulfillmentStatus: body.fulfillmentStatus || 'PENDING',
          lineItems: body.lineItems,
          grandTotal: body.grandTotal,
          customerEmail: body.customerEmail,
          createdOn: body.createdOn,
          modifiedOn: new Date().toISOString(),
        };
        orders.push(order);
        idempotency.set(key, orders.length - 1);
        return send(200, order);
      }

      // ---- Get order ----
      if (req.method === 'GET') {
        const m = url.pathname.match(/^\/1\.0\/commerce\/orders\/([^/]+)$/);
        if (m) {
          const o = findOrder(decodeURIComponent(m[1]));
          if (!o) return send(404, { message: 'not found' });
          return send(200, o);
        }
        // ---- List orders ----
        if (url.pathname === '/1.0/commerce/orders') {
          return send(200, listResponse(url.searchParams));
        }
      }

      return send(404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: 'http://127.0.0.1:' + port,
        orders,
        createCalls,
        failWith429() { rateLimitNext = true; },
        async close() { await new Promise((r) => server.close(r)); },
      });
    });
  });
}
