/**
 * @file config.js
 * @description Environment configuration for the offsite WiPay prototype.
 *
 * Secrets come from the environment only — never hard-coded, never in the
 * storefront. The four WiPay credentials mirror the shipped modules:
 *   WIPAY_ACCOUNT        -> Payment Request identity (no auth header)
 *   WIPAY_API_KEY        -> buyer-return hash verification (server-side only)
 *   WIPAY_WEBHOOK_SECRET -> webhook HMAC verification (server-side only)
 *   WIPAY_WAPI_KEY       -> WAPI refund (X-WAPI-Key or Bearer, never both)
 *
 * Squarespace:
 *   SQUARESPACE_API_KEY       -> Commerce API (Developer API Keys panel)
 *   SQUARESPACE_USER_AGENT    -> required by Squarespace (it rejects
 *                                requests with no User-Agent)
 *   SQUARESPACE_CHANNEL_NAME  -> third-party channel label, <= 30 chars
 *   SQUARESPACE_API_BASE      -> test-only override (mock in the e2e suite)
 *
 * Server:
 *   PORT, PUBLIC_BASE_URL (for response_url), WIPAY_COUNTRY,
 *   WIPAY_ENVIRONMENT, WIPAY_FEE_STRUCTURE, DATA_DIR.
 *
 * WIPAY_API_BASE is a test-only override for the WiPay Payments endpoint —
 * the e2e suite points it at harness/mock_wipay.mjs; production leaves it
 * unset so the host comes from wipay-core.js's verified HOSTS table.
 */

export const DEFAULT_SQUARESPACE_API_BASE = 'https://api.squarespace.com';

import { fileURLToPath } from 'node:url';

export function loadConfig(env) {
  const e = env || process.env;
  const cfg = {
    port: Number(e.PORT) || 8081,
    publicBaseUrl: String(e.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    dataDir: e.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),

    wipay: {
      country: (e.WIPAY_COUNTRY || 'TT').toUpperCase(),
      environment: e.WIPAY_ENVIRONMENT || 'sandbox',
      account: e.WIPAY_ACCOUNT || '',
      apiKey: e.WIPAY_API_KEY || '',
      feeStructure: e.WIPAY_FEE_STRUCTURE || 'merchant_absorb',
      webhookSecret: e.WIPAY_WEBHOOK_SECRET || '',
      wapiCredential: e.WIPAY_WAPI_KEY || '',
      apiBase: e.WIPAY_API_BASE || '', // test-only override, see file header
    },

    squarespace: {
      apiKey: e.SQUARESPACE_API_KEY || '',
      userAgent: e.SQUARESPACE_USER_AGENT || 'Waypoint-WiPay-Squarespace-Prototype/1.0',
      channelName: e.SQUARESPACE_CHANNEL_NAME || 'WiPay Offsite',
      apiBase: e.SQUARESPACE_API_BASE || DEFAULT_SQUARESPACE_API_BASE,
    },
  };

  // The buyer return URL must be absolute; without it a Payment Request
  // would be created with an unusable response_url.
  if (!cfg.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required (e.g. https://pay.example.com)');
  }
  return cfg;
}

/** Throws listing every missing credential the running server needs. */
export function requireWipayCredentials(cfg) {
  const missing = [];
  if (!cfg.wipay.account) missing.push('WIPAY_ACCOUNT');
  if (!cfg.wipay.apiKey) missing.push('WIPAY_API_KEY');
  if (!cfg.wipay.webhookSecret) missing.push('WIPAY_WEBHOOK_SECRET');
  if (missing.length) {
    throw new Error('Missing required credentials: ' + missing.join(', '));
  }
}
