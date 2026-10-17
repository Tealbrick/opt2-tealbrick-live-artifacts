// Sources and refresh (DESIGN §4.4, §4.6). A refresh reads each APPROVED read source through the app's own read-only
// companion grant (`callApp`, C85), applies the declarative projection, and stores the result as the source's snapshot.
// Values go to the owner's preview and (if the owner allowed it) to link viewers — never back to agents (C88/L12).
//
// The schedule is ONE SDK handler job per artifact (kind `refresh`, SDK-API §19: leased, resumable, slice pause makes it
// wait). It is enqueued by the OWNER (trigger_approve), so it keeps running after the agent that made the page is gone
// (DESIGN job O6). Each tick returns `again` with the next interval; after LIMITS.refreshFailures failed ticks in a row
// the page goes to `paused_error` and the job ends until the owner resumes it.
import { createHash } from "node:crypto";
import { digest } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Projection } from "./contract.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import { artifactRow } from "./store.ts";

export const REFRESH_JOB = "refresh";

type CallApp = (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => Promise<{ status: "ok"; output: Json } | { status: "held"; holdId: string }>;

// ─────────────────────────────────────────────────────────── projection

/** RFC 6901 JSON pointer. A missing path is `undefined` (the source then reports `projection_empty`). */
export function pointer(value: Json, path: string | undefined): Json | undefined {
  if (!path) return value;
  let cur: Json | undefined = value;
  for (const raw of path.slice(1).split("/")) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(k)) return undefined;
      cur = cur[Number(k)];
    } else cur = (cur as Record<string, Json>)[k];
  }
  return cur;
}
const pickFrom = (v: Json, pick: readonly string[]): Json => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, Json> = {};
  for (const k of pick) if (Object.hasOwn(v, k)) out[k] = (v as Record<string, Json>)[k] as Json;
  return out;
};
/** Declarative shaping only: pointer → pick fields (on objects, or on each item of an array) → limit (arrays). */
export function project(value: Json, p: Projection): Json | undefined {
  let v = pointer(value, p.path);
  if (v === undefined) return undefined;
  if (p.pick && p.pick.length > 0) v = Array.isArray(v) ? v.map((x) => pickFrom(x, p.pick ?? [])) : pickFrom(v, p.pick);
  if (p.limit !== undefined && Array.isArray(v)) v = v.slice(0, p.limit);
  return v;
}

// ─────────────────────────────────────────────────────────── global call budget

/** At most LIMITS.refreshCallsPerHour companion calls per hour from this app (protects the sources; single replica). */
export class CallBudget {
  private stamps: number[] = [];
  private readonly max: number;
  constructor(max: number = LIMITS.refreshCallsPerHour) {
    this.max = max;
  }
  take(now: number): boolean {
    this.stamps = this.stamps.filter((t) => t > now - 3_600_000);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}
export const budget = new CallBudget();

// ─────────────────────────────────────────────────────────── one refresh

export interface SourceResult {
  key: string;
  status: "ok" | "held" | "error" | "paused" | "not_approved";
  fetchedAt: string | null;
  code: string | null;
}

interface ApprovedSource {
  key: string;
  product: string;
  op: string;
  input: Json;
  projection: Projection;
  approved: boolean;
}
function readSources(db: Db, id: string, keys?: readonly string[]): ApprovedSource[] {
  return db
    .prepare("SELECT key, product, op, input_json, projection_json, digest, approved_digest FROM la_source WHERE artifact_id = ? AND kind = 'read' ORDER BY rowid")
    .all(id)
    .filter((r) => !keys || keys.includes(String(r.key)))
    .map((r) => ({
      key: String(r.key),
      product: String(r.product),
      op: String(r.op),
      input: JSON.parse(String(r.input_json ?? "{}")) as Json,
      projection: JSON.parse(String(r.projection_json ?? "{}")) as Projection,
      approved: r.approved_digest !== null && r.approved_digest === r.digest,
    }));
}

const PAUSE_CODES = new Set(["paused", "workspace_paused", "instance_paused", "kill_switch", "app_paused"]);
export const idemKey = (id: string, key: string, slot: string): string => createHash("sha256").update(`${id}|${key}|${slot}`).digest("hex").slice(0, 48);

/** Write one source result: ok replaces the data; any other outcome keeps the last good data (DESIGN §4.1 la_snapshot). */
function writeSnapshot(db: Db, id: string, key: string, r: { status: SourceResult["status"]; code: string | null; data?: Json }, now: number): void {
  if (r.status === "ok") {
    const text = JSON.stringify(r.data ?? null);
    db.prepare(
      `INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, digest, fetched_at, status, code) VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL)
       ON CONFLICT (artifact_id, key) DO UPDATE SET data_json = excluded.data_json, bytes = excluded.bytes, digest = excluded.digest, fetched_at = excluded.fetched_at, status = 'ok', code = NULL`,
    ).run(id, key, text, utf8Bytes(text), digest(r.data ?? null), now);
    return;
  }
  db.prepare(
    `INSERT INTO la_snapshot (artifact_id, key, status, code) VALUES (?, ?, ?, ?)
     ON CONFLICT (artifact_id, key) DO UPDATE SET status = excluded.status, code = excluded.code`,
  ).run(id, key, r.status, r.code);
}

export interface RefreshOutcome {
  results: SourceResult[];
  /** at least one approved source failed (error), not counting held or paused */
  failed: boolean;
  paused: boolean;
}

/**
 * Read every approved read source of one artifact once and store the snapshots. `write` wraps the DB writes (the job
 * passes ctx.checkpoint so cursor + snapshots + artifact columns are ONE transaction, L31; ops pass db.transaction).
 */
export async function refreshArtifact(
  db: Db,
  callApp: CallApp,
  id: string,
  opts: { slot: string; keys?: readonly string[]; now: () => number; write?: (fn: () => void) => void; after?: (o: RefreshOutcome, now: number) => void },
): Promise<RefreshOutcome> {
  const write = opts.write ?? ((fn) => db.transaction(fn));
  const results: SourceResult[] = [];
  const pending: Array<{ key: string; status: SourceResult["status"]; code: string | null; data?: Json }> = [];
  let failed = false;
  let paused = false;
  for (const s of readSources(db, id, opts.keys)) {
    if (!s.approved) {
      results.push({ key: s.key, status: "not_approved", fetchedAt: null, code: null });
      continue;
    }
    if (!budget.take(opts.now())) {
      pending.push({ key: s.key, status: "error", code: "refresh_budget" });
      failed = true;
      continue;
    }
    try {
      const r = await callApp(s.product, s.op, s.input, { idempotencyKey: idemKey(id, s.key, opts.slot) });
      if (r.status === "held") {
        pending.push({ key: s.key, status: "held", code: r.holdId });
        continue;
      }
      const v = project(r.output, s.projection);
      if (v === undefined) {
        pending.push({ key: s.key, status: "error", code: "projection_empty" });
        failed = true;
        continue;
      }
      if (utf8Bytes(JSON.stringify(v)) > LIMITS.snapshotBytes) {
        pending.push({ key: s.key, status: "error", code: "data_too_large" });
        failed = true;
        continue;
      }
      pending.push({ key: s.key, status: "ok", code: null, data: v });
    } catch (e) {
      const code = e instanceof TbError ? e.code : (e as { code?: string })?.code ?? "refresh_error";
      if (PAUSE_CODES.has(code)) {
        paused = true;
        pending.push({ key: s.key, status: "paused", code });
      } else {
        failed = true;
        pending.push({ key: s.key, status: "error", code: String(code).slice(0, 64) });
      }
    }
  }
  const now = opts.now();
  const at = new Date(now).toISOString();
  for (const p of pending) results.push({ key: p.key, status: p.status, fetchedAt: p.status === "ok" ? at : null, code: p.code });
  results.sort((a, b) => a.key.localeCompare(b.key));
  const outcome: RefreshOutcome = { results, failed, paused };
  // snapshots + the artifact's refresh columns in ONE transaction (L31)
  write(() => {
    for (const p of pending) writeSnapshot(db, id, p.key, p, now);
    opts.after?.(outcome, now);
  });
  return outcome;
}

/** Next attempt after a failed tick: min(interval, 60 s · 2^n) (DESIGN §4.6). */
export const backoffMs = (everySeconds: number, failures: number): number => Math.min(everySeconds * 1000, 60_000 * 2 ** Math.max(0, failures - 1));

/** Artifact refresh columns after a tick, in the same transaction as the snapshots. */
export function recordTick(db: Db, id: string, o: RefreshOutcome, now: number): { state: string; nextAt: number | null; failures: number } {
  const a = artifactRow(db, id);
  if (!a) return { state: "off", nextAt: null, failures: 0 };
  const every = Number(a.refresh_every_s ?? 0);
  let failures = Number(a.consecutive_failures);
  let state = "on";
  let nextAt: number | null;
  if (o.paused) {
    state = "paused"; // a kill switch is not a failure
    nextAt = now + every * 1000;
  } else if (o.failed) {
    failures += 1;
    if (failures >= LIMITS.refreshFailures) {
      state = "paused_error";
      nextAt = null;
    } else nextAt = now + backoffMs(every, failures);
  } else {
    failures = 0;
    nextAt = now + every * 1000;
  }
  db.prepare("UPDATE la_artifact SET refresh_state = ?, next_refresh_at = ?, last_refresh_at = ?, consecutive_failures = ? WHERE id = ?").run(state, nextAt, now, failures, id);
  return { state, nextAt, failures };
}
