# WiPay offsite backend for Squarespace — prototype

A working **offsite payment backend** for Squarespace: Squarespace runs the
storefront, this server takes the order and drives WiPay's hosted checkout,
and a verified payment lands in Squarespace as an order record the merchant
marks paid by hand — because Squarespace's API cannot do that last step
(see [GUIDE.md](../GUIDE.md)'s platform ceiling).

This is the code version of GUIDE.md's recommended workflow: everything the
APIs *can* automate is automated here; the one step they cannot (marking an
order PAID) is surfaced explicitly as `manual_mark_paid` in every record and
as `needs_mark_paid` in the reconcile report.

**Status: 121/121 e2e assertions, exit 0 — including one LIVE sandbox
Payment Request against `ttsb.wipayfinancial.com` (real checkout URL +
transaction id returned).**

## Layout

```
prototype/
├── app/server.js           # the backend (zero dependencies, node:http only)
├── app/store.js            # JSON order store (atomic writes; pinned amounts)
├── app/squarespace.js      # Squarespace Commerce API client (create/get/list)
├── app/config.js           # env-only credentials
├── lib/wipay-core.js       # byte-identical copy of the WiPay contract core
│                           #   (same file as the Wix repo's 127-test core)
├── harness/mock_wipay.mjs  # impersonates the WiPay Payments API
├── harness/mock_squarespace.mjs # enforces the documented Squarespace contract
├── tests/e2e.mjs           # full end-to-end suite (node tests/e2e.mjs)
└── data/                   # runtime state (gitignored)
```

## Run

```
node tests/e2e.mjs                        # full suite, exit 0 = pass
WIPAY_SANDBOX_LIVE=1 node tests/e2e.mjs   # + one real sandbox Payment Request
```

Run the server alone:

```
PORT=8081 PUBLIC_BASE_URL=https://pay.example.com \
BACKEND_TOKEN=... WIPAY_ACCOUNT=... WIPAY_API_KEY=... WIPAY_WEBHOOK_SECRET=... \
SQUARESPACE_API_KEY=... \
node app/server.js
```

Routes: `POST /checkout` (create Payment Request, amount pinned),
`GET /return` (buyer return, hash verified), `POST /webhook` (HMAC-verified,
deduped, authoritative), `GET /admin/orders[/:ref]`,
`POST /admin/orders/:ref/sync`, `GET /admin/reconcile`, `GET /health`.
Admin and checkout routes require `Authorization: Bearer $BACKEND_TOKEN`
(fail closed — no token configured, no access).

## What the e2e suite proves (over real HTTP; three servers on ephemeral ports)

1. **Checkout contract** — Payment Request payload carries the verified WiPay
   field names (`account_number`, `country_code`, `method: credit_card_co`,
   2-decimal `total`, `response_url`), amount pinned server-side, `origin`
   relabelled `WaypointSquarespace`, `data` echo carries the pin.
2. **Idempotency** — same order reference returns the original transaction;
   exactly one Payment Request reaches WiPay.
3. **Buyer return** — hash verified ONLY against the pinned amount: tampered
   hash, hash over `0.01`, hash over an inflated amount, missing hash and
   unknown transaction all rejected (400). A verified return does **not**
   settle the order — the webhook is authoritative.
4. **Webhook** — unsigned/bad-secret/stale/future-timestamp all rejected
   (400/401); duplicate `X-WiPay-Webhook-Id` deduped (recorded exactly once);
   success settles + auto-syncs; a failure event never downgrades a settled
   order.
5. **Squarespace create-order** — the mock *enforces* the documented rules
   (Bearer auth, User-Agent, Idempotency-Key, required body fields,
   `lineItems` non-empty, `priceTaxInterpretation` enum, and **rejects a body
   containing `paymentState`** — it is not an accepted create field). The
   created order lands as `NOT_CHARGED` with `manual_mark_paid: true` — the
   platform ceiling, asserted from the running server.
6. **Sync gating** — an unverified payment can never create a Squarespace
   record (409). Squarespace 429 during settlement: webhook still acks 200,
   error stored, `POST .../sync` retries; replay is idempotent (still exactly
   two Squarespace orders for two payments).
7. **Reconcile report** — counts, `needs_sync`, `sync_errors`, and
   `needs_mark_paid` (every verified order still not PAID in Squarespace, each
   carrying its WiPay transaction id as the audit key).
8. **Durability** — pinned totals, statuses and Squarespace linkage survive a
   server restart; hash verification still works afterwards.
9. **Live sandbox** (opt-in) — one real Payment Request against
   `ttsb.wipayfinancial.com`; ran green 2026-10-20.

## Real vs mocked

| Piece | Status |
|---|---|
| WiPay payload / response-hash / webhook-HMAC / order-id | **real wipay-core.js** (byte-identical to the Wix-repo core, 127/127 there) |
| WiPay Payment Request endpoint | **mock in suite**; live sandbox probe ran green (`WIPAY_SANDBOX_LIVE=1`) |
| Squarespace API contract (auth, headers, required fields, idempotency, rate limit) | **mock, rules transcribed from developers.squarespace.com (2026-10-20)** |
| Real Squarespace API calls | not exercised — needs the merchant's own Developer API Key |
| Buyer actually paying on the hosted page | simulated (return params constructed exactly as WiPay documents) |

## Known limits (honest list)

- **Marking paid stays manual.** No API sets `paymentState`; the mock refuses
  even an attempt. Work `GET /admin/reconcile`'s `needs_mark_paid` list after
  each settlement.
- Single-process store (atomic tmp+rename). Production wants a DB behind the
  same five operations — see the Shopify prototype's flock note for why.
- Create-order is capped by Squarespace at **100/hour/site** (API keys;
  300/min Commerce-wide) — reconcile-on-demand rather than tight polling.
- Refunds are not wired: refund in the WiPay dashboard and reconcile by hand
  (GUIDE.md's documented flow). WAPI refund support can be lifted from the
  Wix repo's `wipay-core.js` helpers when needed.
