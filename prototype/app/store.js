/**
 * @file store.js
 * @description JSON-file order store for the offsite WiPay prototype.
 *
 * Single-process model: Node runs each request handler synchronously through
 * the read-modify-write below, and every flush lands via tmp-file + rename
 * (atomic on the same filesystem), so a crash can never leave a half-written
 * store. The Shopify prototype needed flock() because PHP workers are
 * multi-process; this server is one process, and that is an explicit
 * constraint — production wants a real database behind the same five
 * operations (get / getByTransaction / put / update / list).
 *
 * The store is also where the AMOUNT PIN lives: `pinned_total` is written
 * once at checkout creation and never afterwards, because the buyer-return
 * hash must be recomputed over exactly that value (GUIDE.md step 4).
 */

import fs from 'node:fs';
import path from 'node:path';

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'orders.json');

  let state = { orders: {}, webhookIds: {} };
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim() !== '') {
      try {
        state = JSON.parse(raw);
      } catch (e) {
        // Fail loudly rather than starting with an empty store that would
        // forget every pinned total — that would break hash verification.
        throw new Error('Order store is unreadable (' + file + '): ' + e.message);
      }
    }
    if (!state || typeof state.orders !== 'object' || !state.orders) state.orders = {};
    if (!state.webhookIds || typeof state.webhookIds !== 'object') state.webhookIds = {};
  }

  function flush() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    /** Order record by merchant reference, or null. */
    get(orderReference) {
      return state.orders[String(orderReference)] || null;
    },

    /** Order record indexed by the WiPay-assigned transaction id, or null. */
    getByTransaction(transactionId) {
      const txn = String(transactionId == null ? '' : transactionId);
      if (txn === '') return null;
      for (const rec of Object.values(state.orders)) {
        if (rec.transaction_id === txn) return rec;
      }
      return null;
    },

    /** Inserts a new record. Refuses to overwrite an existing reference. */
    put(record) {
      const ref = String(record.order_reference);
      if (state.orders[ref]) {
        throw new Error('Order record already exists: ' + ref);
      }
      state.orders[ref] = record;
      flush();
      return state.orders[ref];
    },

    /**
     * Read-modify-write: applies `mutator(record)` to the stored record and
     * persists. Returns the mutated record, or null when the reference is
     * unknown. The mutator runs synchronously — no await may sit between the
     * read and the flush, which is what makes this safe in a single process.
     */
    update(orderReference, mutator) {
      const ref = String(orderReference);
      const rec = state.orders[ref];
      if (!rec) return null;
      mutator(rec);
      rec.updated_at = new Date().toISOString();
      flush();
      return rec;
    },

    /** All records, insertion order. */
    list() {
      return Object.values(state.orders);
    },

    /**
     * Webhook idempotency: returns true exactly once per id, remembering it
     * durably so a restart cannot re-process a delivery. Ids are capped
     * (newest wins) to keep the file bounded.
     */
    claimWebhookId(webhookId) {
      const id = String(webhookId);
      if (state.webhookIds[id]) return false;
      state.webhookIds[id] = Date.now();
      const ids = Object.keys(state.webhookIds);
      if (ids.length > 10000) {
        const oldest = Object.entries(state.webhookIds)
          .sort((a, b) => a[1] - b[1])
          .slice(0, ids.length - 10000);
        for (const [k] of oldest) delete state.webhookIds[k];
      }
      flush();
      return true;
    },
  };
}
