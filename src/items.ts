// Item store over the app's own table (migrations/0001_init.sql). Plain functions over the SDK's Db handle,
// so handlers stay thin and tests can run them against the migrated database.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

/** Manifest `scopes[].type` that guards items. */
export const COLLECTION = "collection";

export interface Item {
  id: string;
  collection: string;
  title: string;
  /** ISO 8601 */
  createdAt: string;
}

function toItem(row: Record<string, unknown>): Item {
  return { id: String(row.id), collection: String(row.collection), title: String(row.title), createdAt: new Date(Number(row.created_at)).toISOString() };
}

/** Newest first, across the given collections only (the caller's readable set, resolved by the SDK). */
export function listItems(db: Db, collections: readonly string[], limit: number): Item[] {
  if (collections.length === 0) return [];
  const marks = collections.map(() => "?").join(", ");
  return db
    .prepare(`SELECT id, collection, title, created_at FROM items WHERE collection IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...collections, limit)
    .map(toItem);
}

export function createItem(db: Db, input: { collection: string; title: string; createdBy: string }, now: number = Date.now()): Item {
  const id = `itm_${ulid(now)}`;
  db.prepare("INSERT INTO items (id, collection, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.collection, input.title, input.createdBy, now);
  return { id, collection: input.collection, title: input.title, createdAt: new Date(now).toISOString() };
}
