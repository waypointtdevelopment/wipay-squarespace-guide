# Waypoint WiPay for Squarespace

An independent Squarespace setup guide project maintained by Waypoint. It is not affiliated with, sponsored by, or endorsed by WiPay.

## Project status

**Guide complete (2026-10-13) — reviewed against live Squarespace docs.** No Squarespace payment plugin is possible: Squarespace Payments and Stripe are unavailable to TT/JM/BB/GY/GD merchants, checkout cannot be extended (no custom gateway, no code injection, and the Commerce API cannot mark orders paid — no PATCH on `paymentState`). [GUIDE.md](GUIDE.md) is the working answer: Squarespace runs the storefront, WiPay takes payment via hosted checkout (the same live-sandbox-verified contract as Waypoint's WP/Magento/OpenCart/Shopify work), and orders reconcile through a verified checklist — manual by necessity, with the automation ceiling documented honestly.

## Working backend (prototype/)

The guide's recommended workflow is implemented as a running server: [prototype/](prototype/) is a zero-dependency Node backend that creates WiPay Payment Requests with server-pinned amounts, verifies buyer returns and HMAC-signed webhooks, auto-creates the Squarespace order record via the Commerce API (third-party channel, idempotent), and reports which orders still need the manual mark-paid — the step no API can do. **e2e: 121/121 assertions, exit 0**, including one live sandbox Payment Request (2026-10-20). See [prototype/README.md](prototype/README.md).

## Guide and research

- Read [GUIDE.md](GUIDE.md) for sandbox steps, security boundaries, and manual reconciliation.
- Run the backend: [prototype/README.md](prototype/README.md) (layout, env vars, test suite).
- See [PLATFORM-RESEARCH.md](PLATFORM-RESEARCH.md) for feasibility notes and official platform references.

## Ownership and disclaimer

Waypoint maintains this independent guide project. WiPay does not endorse it. Use is at your own risk; no warranty is provided.
