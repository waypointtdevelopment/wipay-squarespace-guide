# WiPay Payments API workaround guide for Squarespace

**Project type:** documentation and sandbox test guide. This is not a Squarespace payment plugin and does not add WiPay to Squarespace Commerce checkout.

## Platform limitation

Squarespace states that its Commerce API cannot connect a third-party payment processor. Orders in Squarespace Commerce can only be processed through the processors Squarespace supports. This guide therefore does not promise native WiPay checkout, automatic payment status updates, or automatic refunds.

## Workaround choices

- For a fully integrated Squarespace store checkout, use a processor supported by Squarespace.
- To test WiPay alongside a Squarespace site, use a separate merchant-controlled server or test app to create WiPay hosted-checkout requests. Treat the Squarespace order or inquiry as a reference only. Reconcile payment and order status manually unless you build and separately validate a backend integration.
- If you do not operate a secure backend, use the WiPay API collection to explore sandbox requests; do not put a merchant API key in Squarespace page code or a browser form.

## Sandbox walkthrough

1. Choose the sandbox host for the merchant's WiPay territory from [Platforms and Environments](https://docs.wipayfinancial.com/platforms-and-environments). For Trinidad and Tobago the endpoint is https://ttsb.wipayfinancial.com/plugins/payments/request.
2. Use the sandbox request values documented by WiPay: account number 1234567890 and environment sandbox. Set the correct country, currency, fee structure, credit-card method, unique order_id, origin, total, and a response_url on the test backend. Follow the current [Payment Request reference](https://docs.wipayfinancial.com/payments-api).
3. Start checkout from the backend or WiPay's official API collection. The shopper enters card details only on WiPay's hosted page.
4. Test an approved and a declined sandbox transaction using the test-card values in WiPay's current testing documentation.
5. On return, verify successful responses on the server using the response hash, the sandbox API key 123, and the original amount sent in the request. Do not mark an order paid based only on a browser redirect or query string.
6. Record the verified WiPay transaction ID against the Squarespace reference and update the order or customer record manually. Do not fulfill unverified or declined attempts.

## Security and test boundaries

- Keep the API key on the server; never place it in Squarespace code, page source, a public repository, or client-side JavaScript.
- Keep this guide and all test requests in sandbox. Do not substitute live account details or live endpoints.
- Use a unique order_id per attempt and compare the returned amount and currency with the original request.
- This workaround does not connect a WiPay transaction to Squarespace Commerce's payment state. Test inventory, duplicate attempts, cancellations, and manual reconciliation before relying on the workflow.

## Official references

- [WiPay Payments API](https://docs.wipayfinancial.com/payments-api)
- [WiPay sandbox environments](https://docs.wipayfinancial.com/platforms-and-environments)
- [WiPay API collections](https://docs.wipayfinancial.com/api-collections)
- [Squarespace API limitations](https://support.squarespace.com/hc/en-us/articles/236297987-Squarespace-API-keys)
- [Squarespace invoices](https://support.squarespace.com/hc/en-us/articles/30494284979085-Invoicing-clients-and-wholesalers)
