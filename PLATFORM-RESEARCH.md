# Platform research: Squarespace

## Status

**Guide + working offsite backend; reviewed 2026-10-13 and re-verified against live Squarespace docs 2026-10-19/20.** No WiPay
payment plugin is possible on Squarespace. [GUIDE.md](GUIDE.md) documents the offsite workflow, and
[prototype/](prototype/) implements it as a running server (e2e 121/121, live-sandbox probed) — built on the same WiPay
contract that is live-sandbox-verified across Waypoint's WordPress, Magento,
OpenCart, Shopify and Wix work.

## Verdict

**Halt for a native integration; buildable as an offsite flow.** There is no supported public
Squarespace mechanism to add WiPay as a checkout payment method, and no documented API to mark an
order PAID on WiPay's behalf. Everything below is page-text verified from official Squarespace docs
(the search snippets were used for discovery only, never as evidence).

## Verified platform facts (2026-10, re-verified 2026-10-19)

| Fact | Source |
|---|---|
| Squarespace Payments unavailable in TT/JM/BB/GY/GD (US/CA/UK/AU/NZ + Europe only) | Squarespace Payments supported-locations doc |
| Stripe unavailable to merchants based in those five countries; Square is US-only in-person POS; Klarna/Afterpay require Squarespace Payments or Stripe | Processor guide + Stripe country list |
| PayPal is the only native online option worth testing per territory — verify receiving + withdrawal per account (Payouts feature table names Jamaica only) | Squarespace + PayPal docs |
| **No custom/manual gateway at checkout** — no Shopify-style "manual payment method" for the store cart; supported online processors are Squarespace Payments, Stripe and PayPal | [Connect a payment processor](https://support.squarespace.com/hc/en-us/articles/235161188-Connect-a-payment-processor) |
| **Code injection explicitly does not work on checkout** — docs state: *"Checkout pages don't support code"* and *"No. You can't add custom code to checkout pages."* Code can run on the post-checkout order confirmation page only, which cannot implement a payment redirect | [Code injection](https://support.squarespace.com/hc/en-us/articles/205815908-Customize-parts-of-your-site-with-code-injection) |
| **Commerce API cannot mark orders paid** — documents list/retrieve/create(third-party channel)/fulfil only; `paymentState` appears in the Order resource but is read-only, is not in the create-order request, and there is no PATCH endpoint | [Orders API](https://developers.squarespace.com/commerce-apis/orders) · [Orders overview](https://developers.squarespace.com/commerce-apis/orders-overview) |
| Transactions API retrieves transaction records only (no create); supported gateways are Squarespace Payments, Stripe, PayPal, Square — not WiPay | [Transactions overview](https://developers.squarespace.com/commerce-apis/transactions-overview) |
| **Webhooks cover order create/update only** — no external-payment-success event, so webhooks can monitor Squarespace orders but cannot receive WiPay confirmation or mutate payment state | [Webhooks overview](https://developers.squarespace.com/commerce-apis/webhooks/overview) |
| Extensions marketplace has no checkout/gateway extension type; categories are tax, inventory, fulfillment, accounting, SEO, marketing | [Squarespace Extensions](https://support.squarespace.com/hc/en-us/articles/360000975547-Squarespace-Extensions) |
| **No public Invoices API or Pay Links API** in the Commerce API catalogue; both are interface workflows and both bill through the connected processor (Square cannot be used for Pay Links). Manually marking an invoice paid **creates a new pending order** — it does not update an existing web-checkout order | [Invoicing](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers) · [Pay Links](https://support.squarespace.com/hc/en-us/articles/40399291492621-Create-and-manage-Pay-Links) |
| Commerce API changelog through 2026 shows no offsite/redirect gateway flow, hosted-checkout redirect API, or third-party Squarespace Payments API | [Commerce API changelog](https://developers.squarespace.com/commerce-apis/changelog) |

## What is buildable today

Squarespace can host the catalogue and the brand, but not the payment. Invoices, Pay Links and
third-party-channel order import are documented, yet none of them routes Commerce checkout to WiPay
and none can record a WiPay payment as PAID:

- The **external backend pattern works as an external checkout**: a merchant-controlled server
  creates the WiPay Payment Request, the buyer pays on WiPay's hosted page, the server verifies
  server-side, and the merchant reconciles against the Squarespace order.
- Order-record creation **can be automated** via `POST` create-order for a third-party sales channel.
- Reflecting that payment as **PAID in Squarespace cannot be automated** through the public API.
- Invoice/Pay-Link creation is an interface workflow, not a public API.

References: [Connect a payment processor](https://support.squarespace.com/hc/en-us/articles/235161188-Connect-a-payment-processor) · [Commerce payment methods](https://support.squarespace.com/hc/en-us/articles/206541017-What-payment-methods-can-I-accept-with-Squarespace-Commerce) · [Invoices](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers) · [Pay Links](https://support.squarespace.com/hc/en-us/articles/40399291492621-Create-and-manage-Pay-Links) · [Orders API overview](https://developers.squarespace.com/commerce-apis/orders-overview)

## Hard constraint

Squarespace's documented online Commerce processors are Squarespace Payments, Stripe and PayPal, with
Square documented for in-person POS. There is no documented way to connect WiPay as an additional
online checkout processor, no checkout extension API, and no code-injection surface on checkout.

## What is not buildable today

No native WiPay checkout integration for Squarespace Commerce. Do not promise automatic Squarespace
order confirmation, payment status synchronization, or automatic refunds. If native, automatic order
states are a hard requirement, direct the merchant to an extension-capable platform (WooCommerce,
Magento, OpenCart, BigCommerce, PrestaShop).

## Next decisions

- ~~Confirm WiPay payment-link/invoice features~~ — **resolved**: Payment Request API is called
  directly from a merchant backend; payload/response/hash/webhook contract live-verified (2026-10).
- ~~Re-check Squarespace's official processor limitations~~ — **resolved** above, dated sources in
  GUIDE.md.
- Open: confirm the exact reconciliation cadence a merchant will actually run manually, since
  Squarespace's payment state will never self-attest.

## Scope of "impossible"

"Impossible" means impossible through the **documented public** Squarespace checkout, API and
extension mechanisms. It is not a claim that a private/unpublished Squarespace arrangement could not
exist, nor that Squarespace could not ship such a capability later.

## References

- [Squarespace API keys / limitations](https://support.squarespace.com/hc/en-us/articles/236297987-Squarespace-API-keys)
- [What payment methods can I accept](https://support.squarespace.com/hc/en-us/articles/206541017-What-payment-methods-can-I-accept-with-Squarespace-Commerce)
- [Connect a payment processor](https://support.squarespace.com/hc/en-us/articles/235161188-Connect-a-payment-processor)
- [Supported countries and currencies](https://support.squarespace.com/hc/en-us/articles/205811248-Supported-countries-and-currencies-for-Squarespace-Commerce)
- [Squarespace Payments supported locations](https://support.squarespace.com/hc/en-us/articles/33482360045069-Supported-locations-payment-methods-and-currencies-for-Squarespace-Payments)
- [Commerce Orders API](https://developers.squarespace.com/commerce-apis/orders)
- [Commerce API overview](https://developers.squarespace.com/commerce-apis/overview)
- [Commerce API changelog](https://developers.squarespace.com/commerce-apis/changelog)
- [Commerce webhooks](https://developers.squarespace.com/commerce-apis/webhooks/overview)
- [Code injection](https://support.squarespace.com/hc/en-us/articles/205815908-Customize-parts-of-your-site-with-code-injection)
- [Invoicing](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers)
- [Pay Links](https://support.squarespace.com/hc/en-us/articles/40399291492621-Create-and-manage-Pay-Links)
- [Squarespace Extensions](https://support.squarespace.com/hc/en-us/articles/360000975547-Squarespace-Extensions)
