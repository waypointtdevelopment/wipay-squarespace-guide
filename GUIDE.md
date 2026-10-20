# WiPay on Squarespace — merchant setup guide

**Project type:** documentation. This is **not** a plugin — Squarespace cannot
install payment plugins, and its checkout cannot be extended with WiPay. This
guide is the honest, working alternative: Squarespace runs your storefront;
WiPay takes the payment; you reconcile with a checklist (and, if you want,
a small backend that automates everything except the Squarespace status).

Everything in the "WiPay side" section below is the same contract that is
live-sandbox-verified in Waypoint's WordPress, Magento, OpenCart and Shopify
work (sandbox probes returned real checkout URLs and transaction IDs).

## The platform ceiling (verified against Squarespace docs, Oct 2026; re-verified 2026-10-19)

- **Squarespace Payments and Stripe are not available** to merchants based in
  TT, JM, BB, GY or GD. Square is US-only in-person POS. PayPal is the only
  native online option worth testing — and its capabilities vary by country
  (confirm receiving + withdrawal for your territory before relying on it).
- **No custom/manual gateway at checkout.** Unlike Shopify, Squarespace has
  no "manual payment method" you can name "WiPay" at the cart. Code injection
  explicitly does **not** work on checkout pages.
- **The Commerce API cannot mark orders paid.** It can list, retrieve,
  create (third-party channel) and fulfil orders — but there is no endpoint
  to patch `paymentState`. No amount of backend code can make a Squarespace
  store order auto-complete on payment.

So: **payment happens off-platform, by design.** The goal of this guide is to
make that safe, professional, and low-friction.

## Recommended workflow (storefront → WiPay → reconcile)

1. **Squarespace = catalogue + brand.** Set your store's checkout to a
   supported low-friction option (e.g. PayPal where it works), or disable
   card checkout and route buyers explicitly: *"Complete purchase securely
   with WiPay"*.
2. **Order capture.** Either:
   - (a) Buyer checks out on Squarespace with an offline/manual arrangement
     and you email a WiPay payment link; or
   - (b) a small merchant-controlled page/backend (not on Squarespace) takes
     the order details and creates a WiPay Payment Request server-side —
     this is the cleaner path and what Waypoint's other modules do.
     **This is now implemented:** [prototype/](prototype/) is that backend —
     pinned amounts, verified returns, HMAC webhooks, automatic Squarespace
     order-record creation, and a reconcile report of everything still
     needing the manual mark-paid. e2e 121/121, live-sandbox probed.
3. **WiPay hosted page.** The buyer enters card details only on
   `*.wipayfinancial.com`. Your store never touches card data.
4. **Verify server-side, never from the redirect.** On return, recompute
   `md5(transaction_id + original_total_2dp + api_key)` and compare
   constant-time against the `hash` parameter — using **the amount your
   server pinned when creating the request**, not the customer-facing total
   in the redirect (WiPay's docs are explicit about this).
5. **Webhooks are the safety net.** Register an endpoint (HMAC-SHA256 over
   `timestamp + "." + raw body`, ±300 s window, dedupe by event ID) so
   abandoned returns still settle. Success webhook = authoritative.
6. **Reconcile into Squarespace.** Create the matching order record and mark
   it paid once (and only once) your server has verified the payment. Keep
   the WiPay transaction ID in the record's notes — that's your audit trail,
   because Squarespace's status will never prove payment.

   **This step splits, and the split matters:** creating the order record
   *can* be automated — the Orders API accepts `POST` create-order for a
   third-party sales channel. Marking it paid **cannot** — `paymentState` is
   read-only with no PATCH, and Squarespace's webhooks cover order
   create/update only (no external-payment-success event). So automate the
   record, then mark paid by hand, every time.

   The prototype automates exactly this: webhook settlement triggers
   `POST /1.0/commerce/orders` (with `Idempotency-Key`, `channelName`,
   `externalOrderReference` as the audit key — and deliberately **no**
   `paymentState`, which is not an accepted create field), then
   `GET /admin/reconcile` lists every synced order still not `PAID` as
   `needs_mark_paid`, each with its WiPay transaction id.

## Sandbox walkthrough

1. Pick your territory's sandbox host
   ([Platforms and Environments](https://docs.wipayfinancial.com/platforms-and-environments));
   for Trinidad & Tobago it is `https://ttsb.wipayfinancial.com`, and the
   Payment Request path is `POST /plugins/payments/request`.
   [API collections](https://docs.wipayfinancial.com/api-collections) have a
   runnable starting point.
2. Send a server-side Payment Request with the sandbox test values:
   `account_number=1234567890`, `environment=sandbox`,
   `fee_structure=merchant_absorb` (live-verified values: `customer_pay`,
   `merchant_absorb`, `split` — anything else is a 400), a unique
   alphanumeric `order_id` (≤ 16 chars recommended), and a
   `response_url` on your backend. Full field list:
   [Payment Request](https://docs.wipayfinancial.com/payments-api/payment-request).
3. Expect `HTTP 200` with `{url, message: "OK", transaction_id}` — the
   `url` is the hosted checkout page; the `transaction_id` is assigned by
   WiPay **now** (store it — your callback arrives with it, not with an ID
   you invent).
4. Run one approved and one declined test card from WiPay's testing docs.
5. On return, verify the hash as described above before considering the
   payment real.
6. Confirm a webhook event arrives and is signature-verified, and that a
   replay of the same event ID is deduplicated.

## Security boundaries (non-negotiable)

- API keys live on the server only — never in Squarespace code, page source,
  client-side JavaScript, or public repos. (Squarespace's own code-injection
  surface is not a place for secrets regardless — checkout doesn't support it.)
- Pin amounts server-side; the browser never tells you what to charge.
- The browser redirect is a UX signal; the hash check and the webhook are
  the truth. Never fulfil on a redirect alone.
- Stay in sandbox until your flow — including decline, duplicate-attempt,
  abandoned-return and webhook-late-arrival cases — has been walked once.

## What this workflow cannot do

- Auto-complete a Squarespace store order on payment (no API for it).
- Offer WiPay inside Squarespace's cart checkout.
- Refund automatically through Squarespace (refund in the WiPay dashboard;
  keep the Squarespace record in sync by hand).

If native, automatic order states are a hard requirement, a platform with a
real extension surface (WooCommerce, Magento, OpenCart, BigCommerce,
PrestaShop) is the better home for the store.

## Official references

- [WiPay Payments API](https://docs.wipayfinancial.com/payments-api)
- [WiPay Payment Request reference](https://docs.wipayfinancial.com/payments-api/payment-request)
- [WiPay sandbox environments](https://docs.wipayfinancial.com/platforms-and-environments)
- [Connect a payment processor (Squarespace)](https://support.squarespace.com/hc/en-us/articles/235161188-Connect-a-payment-processor)
- [Squarespace Commerce API — Orders](https://developers.squarespace.com/commerce-apis/orders)
- [Code injection limitations (checkout unsupported)](https://support.squarespace.com/hc/en-us/articles/205815908-Customize-parts-of-your-site-with-code-injection)
- [Squarespace invoicing (manual mark-paid)](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers)
