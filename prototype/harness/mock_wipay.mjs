/**
 * @file mock_wipay.mjs
 * @description Impersonates the WiPay Payments API for the e2e suite: serves
 * POST /plugins/payments/request and returns the documented 200 shape
 * {url, message, transaction_id}. The checkout URL it hands back is on the
 * real ttsb.wipayfinancial.com host (as the sandbox would) but nothing is
 * fetched — the buyer "pays" by the test constructing the documented return
 * params itself, exactly like the Shopify prototype's simulated return.
 *
 * It also exposes control helpers the suite uses:
 *   .requests            every payload received (assert field names/values)
 *   .failNext(status)    make the next Payment Request fail (error path)
 *   .close()             stop listening
 *
 * This is the only fake in the suite. The response hash, webhook HMAC and
 * payload construction all run through the real wipay-core.js copy.
 */

import http from 'node:http';

export function startMockWiPay() {
  const requests = [];
  let failNextStatus = 0;
  let txnCounter = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/plugins/payments/request') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = { __parse_error: raw }; }
      requests.push({ headers: req.headers, payload });

      if (failNextStatus) {
        const s = failNextStatus;
        failNextStatus = 0;
        res.writeHead(s, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'simulated failure' }));
        return;
      }

      txnCounter += 1;
      const txn = 'SB-76-1-SQSP-' + String(Date.now()) + String(txnCounter % 10);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // The same Accept-dependent behaviour as the real endpoint: JSON
        // only when the client asked for it (our server always does).
        'X-Mock-WiPay': '1',
      });
      res.end(JSON.stringify({
        url: 'https://ttsb.wipayfinancial.com/checkout/payment?_data=' + encodeURIComponent(txn),
        message: 'OK',
        transaction_id: txn,
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: 'http://127.0.0.1:' + port,
        requests,
        failNext(status) { failNextStatus = status; },
        async close() { await new Promise((r) => server.close(r)); },
      });
    });
  });
}
