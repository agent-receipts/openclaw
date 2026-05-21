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
import { ReceiptStore, verifyStoredChain, type ChainVerification } from "@agnt-rcpt/sdk-ts";

/**
 * Narrow read-only view of a ReceiptStore.
 * Callers cannot accidentally invoke write methods (insert, migrate, etc.).
 * The unsafe constructor bypass stays inside openDaemonStore — nothing outside
 * this module needs to know about it.
 */
export type DaemonStoreReader = Pick<ReceiptStore, "query" | "stats" | "close" | "getChain">;

/**
 * Open the daemon's SQLite receipt DB read-only.
 * Caller must call .close() when done.
 */
/**
 * Verify a receipt chain against a public key, using a DaemonStoreReader.
 * The unsafe cast to ReceiptStore lives here, next to the other bypass code,
 * so tools.ts stays free of type assertions.
 */
export function verifyDaemonChain(
  store: DaemonStoreReader,
  chainId: string,
  publicKeyPEM: string,
): ChainVerification {
  return verifyStoredChain(store as unknown as ReceiptStore, chainId, publicKeyPEM);
}

export function openDaemonStore(dbPath: string): DaemonStoreReader {
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
