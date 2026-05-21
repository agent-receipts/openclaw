/**
 * Read-only access to the daemon's SQLite receipt store.
 *
 * Opens the database with mode=ro so the plugin never holds a write lock
 * that could interfere with the daemon. Schema init and migration are skipped
 * because the daemon initialises the schema on startup.
 *
 * TODO: replace Object.create bypass with openStoreReadOnly() from
 * @agnt-rcpt/sdk-ts once version >=0.9.0 is published (agent-receipts/ar#471).
 * The runtime behaviour is identical — only the import changes.
 */

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ReceiptStore } from "@agnt-rcpt/sdk-ts";

/**
 * Open the daemon's SQLite receipt DB read-only.
 * Caller must call .close() when done.
 */
export function openDaemonStore(dbPath: string): ReceiptStore {
  const uri = `${pathToFileURL(dbPath).href}?mode=ro`;
  const db = new DatabaseSync(uri);
  // Bypass ReceiptStore constructor to skip schema init — the daemon has
  // already initialised the schema and we must not attempt writes on a
  // read-only handle. TypeScript's `private` compiles to a regular JS
  // property, so direct assignment via double-cast is safe at runtime.
  const store = Object.create(ReceiptStore.prototype) as ReceiptStore;
  (store as unknown as { db: DatabaseSync }).db = db;
  return store;
}
