// Sources and refresh (DESIGN §4.4, §4.6). A refresh reads each APPROVED read source through the app's own read-only
// companion grant (`callApp`, C85), applies the declarative projection, and stores the result as the source's snapshot.
// Values go to the owner's preview and (if the owner allowed it) to link viewers — never back to agents (C88/L12).
//
// The schedule is ONE SDK handler job per artifact (kind `refresh`, SDK-API §19: leased, resumable, slice pause makes it
// wait). It is enqueued by the OWNER (trigger_approve), so it keeps running after the agent that made the page is gone
// (DESIGN job O6). After LIMITS.refreshFailures failed ticks in a row the page goes to `paused_error`.
//
// Race rule (review PR #3, findings 1–2): a read takes time. The binding may change, be revoked or flip to a push source
// while the call is in flight. Every result is written ONLY if the source row still is the same approved read binding
// (same key, kind read, digest = approved digest = the digest captured before the call). Otherwise it is discarded.
import { createHash } from "node:crypto";
import { digest } from "@opt2-tealbrick/manifest";
import { type Db, type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Projection } from "./contract.ts";
import { LIMITS, utf8Bytes } from "./limits.ts";
import { artifactRow } from "./store.ts";

export const REFRESH_JOB = "refresh";

type CallApp = (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => Promise<{ status: "ok"; output: Json } | { status: "held"; holdId: string }>;

// ─────────────────────────────────────────────────────────── projection

/** RFC 6901 JSON pointer over OWN properties only (no prototype walk, finding 12). Missing → undefined. */
export function pointer(value: Json, path: string | undefined): Json | undefined {
  if (!path) return value;
  let cur: Json | undefined = value;
  for (const raw of path.slice(1).split("/")) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(k)) return undefined;
      cur = cur[Number(k)];
    } else {
      if (!Object.hasOwn(cur, k)) return undefined;
      cur = (cur as Record<string, Json>)[k];
    }
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

// ─────────────────────────────────────────────────────────── call budgets

/** A sliding one-hour window (single replica; resets on restart, which only ever ALLOWS fewer calls than before). */
export class CallBudget {
  private stamps: number[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  take(now: number): boolean {
    this.stamps = this.stamps.filter((t) => t > now - 3_600_000);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}
/** Scheduled refreshes and agent-asked refreshes have SEPARATE budgets, so agents cannot starve the schedule (finding 4). */
export const budgets = { scheduled: new CallBudget(LIMITS.refreshCallsPerHour), manual: new CallBudget(LIMITS.manualCallsPerHour) };

// ─────────────────────────────────────────────────────────── one refresh

export interface SourceResult {
  key: string;
  status: "ok" | "held" | "error" | "paused" | "not_approved";
  fetchedAt: string | null;
  code: string | null;
}

interface ReadBinding {
  key: string;
  product: string;
  op: string;
  input: Json;
  projection: Projection;
  digest: string;
}
/** The approved read binding of one key RIGHT NOW, or null (revoked, changed, flipped to push, deleted). */
function currentBinding(db: Db, id: string, key: string): ReadBinding | null {
  const r = db.prepare("SELECT key, kind, product, op, input_json, projection_json, digest, approved_digest FROM la_source WHERE artifact_id = ? AND key = ?").get(id, key);
  if (!r || String(r.kind) !== "read" || r.approved_digest === null || r.approved_digest !== r.digest) return null;
  return {
    key: String(r.key),
    product: String(r.product),
    op: String(r.op),
    input: JSON.parse(String(r.input_json ?? "{}")) as Json,
    projection: JSON.parse(String(r.projection_json ?? "{}")) as Projection,
    digest: String(r.digest),
  };
}
const readKeys = (db: Db, id: string, keys?: readonly string[]): string[] =>
  db
    .prepare("SELECT key FROM la_source WHERE artifact_id = ? AND kind = 'read' ORDER BY rowid")
    .all(id)
    .map((r) => String(r.key))
    .filter((k) => !keys || keys.includes(k));

const PAUSE_CODES = new Set(["paused", "workspace_paused", "instance_paused", "kill_switch", "app_paused"]);
/** Not the source's fault and not a failure: try again later (finding 13: rate limits; finding 4: our own budget). */
const DEFER_CODES = new Set(["rate_limited", "refresh_budget", "bridge_busy"]);
export const idemKey = (parts: readonly string[]): string => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 48);

interface Pending {
  binding: ReadBinding;
  status: SourceResult["status"];
  code: string | null;
  data?: Json;
  holdKey?: string | null;
}

/** Write one result if (and only if) the binding is still the same approved read binding. Returns whether it wrote. */
function guardedWrite(db: Db, id: string, p: Pending, now: number): boolean {
  const cur = currentBinding(db, id, p.binding.key);
  if (!cur || cur.digest !== p.binding.digest) return false; // changed while in flight → discard
  if (p.status === "ok") {
    const text = JSON.stringify(p.data ?? null);
    db.prepare(
      `INSERT INTO la_snapshot (artifact_id, key, data_json, bytes, digest, fetched_at, status, code, hold_key) VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, NULL)
       ON CONFLICT (artifact_id, key) DO UPDATE SET data_json = excluded.data_json, bytes = excluded.bytes, digest = excluded.digest, fetched_at = excluded.fetched_at,
         status = 'ok', code = NULL, hold_key = NULL`,
    ).run(id, p.binding.key, text, utf8Bytes(text), digest(p.data ?? null), now);
    return true;
  }
  db.prepare(
    `INSERT INTO la_snapshot (artifact_id, key, status, code, hold_key) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (artifact_id, key) DO UPDATE SET status = excluded.status, code = excluded.code, hold_key = excluded.hold_key`,
  ).run(id, p.binding.key, p.status, p.code, p.status === "held" ? (p.holdKey ?? null) : null);
  return true;
}

/** Bytes of the OTHER snapshots of a page (the 1 MiB page cap holds for refresh writes too, finding 13). */
const otherBytes = (db: Db, id: string, key: string): number =>
  Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(data_json, '') AS BLOB)) + LENGTH(CAST(COALESCE(staged_json, '') AS BLOB))), 0) AS b FROM la_snapshot WHERE artifact_id = ? AND key <> ?",
      )
      .get(id, key)?.b ?? 0,
  );

export interface RefreshOutcome {
  results: SourceResult[];
  /** at least one approved source failed (error) */
  failed: boolean;
  /** a kill switch answered (counts as no failure) */
  paused: boolean;
  /** nothing was read because of rate limits or budgets (no failure; try again soon) */
  deferred: boolean;
}

export interface RefreshOptions {
  /** scheduled ticks and agent requests use separate budgets and separate idempotency keys */
  mode: "scheduled" | "manual";
  /** part of the idempotency key: the interval slot (scheduled) or the minute (manual) */
  slot: string;
  /** failures so far (scheduled): a retry after a failure uses a NEW key so a target-side unknown outcome is re-run */
  attempt?: number;
  keys?: readonly string[];
  now: () => number;
  signal?: AbortSignal;
  write?: (fn: () => void) => void;
  after?: (o: RefreshOutcome, now: number) => void;
}

/**
 * Read every approved read source of one artifact once and store the snapshots. Each source's binding is re-checked just
 * before its call and again inside the write transaction. `write` wraps the DB writes (the job passes ctx.checkpoint so
 * snapshots + the artifact's refresh columns are ONE transaction, L31).
 */
export async function refreshArtifact(db: Db, callApp: CallApp, id: string, opts: RefreshOptions): Promise<RefreshOutcome> {
  const write = opts.write ?? ((fn) => db.transaction(fn));
  const budget = budgets[opts.mode];
  const results: SourceResult[] = [];
  const pending: Pending[] = [];
  let failed = false;
  let paused = false;
  let deferred = false;
  for (const key of readKeys(db, id, opts.keys)) {
    if (opts.signal?.aborted) break; // a cancelled, paused or timed-out tick stops reading (finding 2)
    const b = currentBinding(db, id, key); // re-checked right before the call
    if (!b) {
      results.push({ key, status: "not_approved", fetchedAt: null, code: null });
      continue;
    }
    if (!budget.take(opts.now())) {
      deferred = true;
      results.push({ key, status: "error", fetchedAt: null, code: "refresh_budget" });
      continue;
    }
    // a held read keeps its key until the hold is decided (one hold per read, not one per tick; C105a)
    const prev = db.prepare("SELECT status, hold_key FROM la_snapshot WHERE artifact_id = ? AND key = ?").get(id, key);
    const heldKey = prev && String(prev.status) === "held" && prev.hold_key ? String(prev.hold_key) : null;
    const k = heldKey ?? idemKey([opts.mode, id, key, b.digest, opts.slot, String(opts.attempt ?? 0)]);
    try {
      const r = await callApp(b.product, b.op, b.input, { idempotencyKey: k });
      if (r.status === "held") {
        pending.push({ binding: b, status: "held", code: r.holdId, holdKey: k });
        continue;
      }
      const v = project(r.output, b.projection);
      let text: string | undefined;
      try {
        text = v === undefined ? undefined : JSON.stringify(v);
      } catch {
        text = undefined;
      }
      if (v === undefined || text === undefined) {
        pending.push({ binding: b, status: "error", code: "projection_empty" });
        failed = true;
        continue;
      }
      const bytes = utf8Bytes(text);
      if (bytes > LIMITS.snapshotBytes || otherBytes(db, id, key) + bytes > LIMITS.artifactDataBytes) {
        pending.push({ binding: b, status: "error", code: "data_too_large" });
        failed = true;
        continue;
      }
      pending.push({ binding: b, status: "ok", code: null, data: JSON.parse(text) as Json });
    } catch (e) {
      const code = String(e instanceof TbError ? e.code : ((e as { code?: string })?.code ?? "refresh_error")).slice(0, 64);
      if (PAUSE_CODES.has(code)) {
        paused = true;
        pending.push({ binding: b, status: "paused", code });
      } else if (DEFER_CODES.has(code)) {
        deferred = true;
        results.push({ key, status: "error", fetchedAt: null, code });
      } else {
        failed = true;
        pending.push({ binding: b, status: "error", code });
      }
    }
  }
  const now = opts.now();
  const at = new Date(now).toISOString();
  const outcome: RefreshOutcome = { results, failed, paused, deferred };
  write(() => {
    for (const p of pending) {
      const wrote = guardedWrite(db, id, p, now);
      results.push(
        wrote
          ? { key: p.binding.key, status: p.status, fetchedAt: p.status === "ok" ? at : null, code: p.status === "held" ? null : p.code }
          : { key: p.binding.key, status: "not_approved", fetchedAt: null, code: "binding_changed" },
      );
    }
    results.sort((a, b) => a.key.localeCompare(b.key));
    opts.after?.(outcome, now);
  });
  return outcome;
}

/** Next attempt after a failed tick: min(interval, 60 s · 2^n) (DESIGN §4.6). */
export const backoffMs = (everySeconds: number, failures: number): number => Math.min(everySeconds * 1000, 60_000 * 2 ** Math.max(0, failures - 1));

/**
 * Artifact refresh columns after a tick, in the same transaction as the snapshots. Written only while the schedule is
 * still approved and owned by THIS job (finding 7): an update or owner change during the tick wins.
 * A failure wins over a pause (finding 9): a kill switch on one source does not hide another source's failure.
 */
export function recordTick(db: Db, id: string, jobId: string, o: Pick<RefreshOutcome, "failed" | "paused" | "deferred">, now: number): { state: string; nextAt: number | null } | null {
  const a = artifactRow(db, id);
  if (!a || Number(a.refresh_approved) !== 1 || String(a.refresh_job_id) !== jobId) return null;
  const every = Number(a.refresh_every_s ?? 0);
  let failures = Number(a.consecutive_failures);
  let state = "on";
  let nextAt: number | null;
  if (o.failed) {
    failures += 1;
    if (failures >= LIMITS.refreshFailures) {
      state = "paused_error";
      nextAt = null;
    } else nextAt = now + backoffMs(every, failures);
  } else if (o.paused) {
    state = "paused"; // a kill switch is not a failure
    nextAt = now + every * 1000;
  } else if (o.deferred) {
    nextAt = now + Math.min(every * 1000, 60_000); // rate limit or budget: soon again, no failure counted
  } else {
    failures = 0;
    nextAt = now + every * 1000;
  }
  db.prepare(
    "UPDATE la_artifact SET refresh_state = ?, next_refresh_at = ?, last_refresh_at = ?, consecutive_failures = ? WHERE id = ? AND refresh_approved = 1 AND refresh_job_id = ?",
  ).run(state, nextAt, now, failures, id, jobId);
  return { state, nextAt };
}
