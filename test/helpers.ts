// Test helpers: a migrated node:sqlite database shaped like the SDK `Db`, and a handler context with a fake scope view
// (same shape as the SDK's: person callers see every gallery; agents see the galleries in `access`).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CrudAction } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return db as unknown as Db;
}

export const CRUD = {
  read: ["read"],
  contribute: ["read", "create", "update"],
  manage: ["read", "create", "update", "delete"],
} as const satisfies Record<string, readonly CrudAction[]>;

export interface FakeCaller {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
  mode?: "free" | "bound";
}
export interface Instance {
  type: string;
  id: string;
  label: string;
  shared: boolean;
}

export const AGENT_A: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout" };
export const AGENT_B: FakeCaller = { type: "agent", id: "agt_01J0000000000000000000000B", name: "Clerk" };
export const OWNER: FakeCaller = { type: "person", id: "per_01J00000000000000000000000", name: "Owner" };

/** A handler context. `access`: gallery id → CRUD set (ignored for person callers, who may act everywhere).
 *  `instances` is shared between contexts of one test (it plays the SDK scope store). */
export function ctxFor(
  db: Db,
  caller: FakeCaller,
  access: Record<string, readonly CrudAction[]> = {},
  instances: Instance[] = [],
  context: Record<string, unknown> = {},
): OpContext & { instances: Instance[]; changed: number } {
  const person = caller.type === "person";
  const state = { changed: 0 };
  const ctx = {
    db,
    caller: { ...caller, mode: caller.type === "agent" ? (caller.mode ?? "free") : null },
    context,
    publicUrl: "https://bridge.example",
    scope: {
      access: null,
      readable: async () => (person ? instances.map((i) => i.id) : Object.keys(access).filter((p) => access[p]?.includes("read"))),
      writable: async () => (person ? instances.map((i) => i.id) : Object.keys(access).filter((p) => access[p]?.some((c) => c !== "read"))),
      can: async (_t: string, id: string, crud: CrudAction) => person || (access[id]?.includes(crud) ?? false),
    },
    scopes: {
      instances: {
        create: async (type: string, id: string, label: string, opts?: { shared?: boolean }) => {
          const i = { type, id, label, shared: opts?.shared ?? false };
          const at = instances.findIndex((x) => x.id === id);
          if (at >= 0) instances[at] = i;
          else instances.push(i);
          return i;
        },
        list: async () => [...instances],
      },
    },
    ownerLink: (path: string) => `https://portal.example/w/ws/open?product=live-artifacts&path=${encodeURIComponent(path)}`,
    statusChanged: () => {
      state.changed++;
    },
    instances,
    get changed() {
      return state.changed;
    },
  };
  return ctx as unknown as OpContext & { instances: Instance[]; changed: number };
}
