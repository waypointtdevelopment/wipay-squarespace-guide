# Platform research: Squarespace

## Status
Guide-only workspace. Squarespace says its Commerce API cannot connect third-party processors, so a normal WiPay checkout plugin is not currently a documented option.

## What is buildable today
Squarespace documents supported off-platform payment features, but they are not WiPay-backed Commerce checkout. Invoices and Pay Links are supported, yet both still rely on a **connected Squarespace-supported processor** for online payment; Squarespace also documents manually marking an invoice paid for cash, check, or bank transfer. Commerce APIs expose order information and third-party-channel order import, but the public docs do not show a way to add a checkout processor or route Commerce checkout to WiPay.

- [Connect a payment processor](https://support.squarespace.com/hc/en-us/articles/235161188-Connect-a-payment-processor)
- [Commerce payment methods](https://support.squarespace.com/hc/en-us/articles/206541017-What-payment-methods-can-I-accept-with-Squarespace-Commerce)
- [Invoices](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers)
- [Pay Links](https://support.squarespace.com/hc/en-us/articles/40399291492621-Create-and-manage-Pay-Links)
- [Orders API overview](https://developers.squarespace.com/commerce-apis/orders-overview)

## Hard constraint
Squarespace's documented online Commerce processors are Squarespace Payments, Stripe, and PayPal, with Square documented for in-person POS. There is no documented way to connect WiPay as an additional online checkout processor.

## What is not buildable today
No native WiPay checkout integration for Squarespace Commerce checkout is a documented option. Do not promise automatic Squarespace order confirmation, payment status synchronization, or automatic refunds.

## Next decisions
- Confirm WiPay payment-link/invoice features, disclosures, and reconciliation steps before publishing a manual workflow.
- Re-check Squarespace's official processor limitations before publishing any guide.

## References
- [Squarespace Commerce API payment limitation](https://support.squarespace.com/hc/en-us/articles/236297987-Squarespace-API-keys)
- [Squarespace accepted payment methods](https://support.squarespace.com/hc/en-us/articles/206541017-What-payment-methods-can-I-accept-with-Squarespace-Commerce)
