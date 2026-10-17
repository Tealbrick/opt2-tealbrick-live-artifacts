// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation, OpenAPI,
// receipts, holds, idempotency, scopes, backups and status from it. This file registers exactly one handler per manifest
// operation id. Op ids and I/O types come from the generated kit (#kit).
//
// Access (DESIGN §4.1): a gallery is the scope instance (type `gallery`): every agent gets its own (id = its caller id)
// and one `shared` gallery exists. Ops that name a gallery let the SDK check it. Ops that name an artifact return null
// ("across galleries") and the handler checks the artifact's gallery with ctx.scope.can (unreadable = not found, the same
// answer as a missing id). The destructive delete resolves the gallery first, so the SDK checks delete access to THAT
// gallery before it opens a hold. Person calls (the owner's UI) may act on every gallery.
//
// What agents never get (C88/L12, DESIGN §3.3): values read from another app. artifact_get returns the shape of that data
// only; `include: data` returns the agents' own pushed data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CrudAction } from "@opt2-tealbrick/manifest";
import type { JobContext, JobsApi } from "@opt2-tealbrick/miniapp-sdk";
import { type AppDefinition, type Db, defineApp, type HandlerSpec, type Json, type OpContext, type SdkAppDefinition, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type ArtifactArchiveInput,
  type ArtifactCreateInput,
  type ArtifactDataPutInput,
  type ArtifactDeleteInput,
  type ArtifactDetailInput,
  type ArtifactGetInput,
  type ArtifactListInput,
  type ArtifactNewInput,
  type ArtifactPreviewTicketInput,
  type ArtifactRefreshInput,
  type ArtifactRemoveInput,
  type ArtifactUpdateInput,
  type AutopublishSetInput,
  type GalleriesListInput,
  type GalleryViewInput,
  OP,
  type OpId,
  type PublishVersionInput,
  type SettingsSetInput,
  type SourceApproveInput,
  type SourceRevokeInput,
  type SourceTestInput,
  type TriggerApproveInput,
} from "#kit";
import { companionOps, EMPTY_CONTRACT, normalizeContract, parseStoredContract, type RawContract } from "./contract.ts";
import { LIMITS } from "./limits.ts";
import { type LintItem, lintErrors, lintHtml } from "./lint.ts";
import { project, REFRESH_JOB, recordTick, refreshArtifact } from "./refresh.ts";
import {
  type Actor,
  activityOf,
  artifactRow,
  countByGallery,
  createArtifact,
  deleteArtifact,
  GALLERY,
  getSettings,
  linksOf,
  listArtifacts,
  notFound,
  publishVersion,
  pushedDataOf,
  putData,
  SHARED_GALLERY,
  setArchived,
  setAutoPublish,
  setSettings,
  shapesOf,
  sourcesOf,
  toDetail,
  updateArtifact,
  versionOut,
  versionRow,
  versionsOf,
} from "./store.ts";
import { createPreview, VIEW_PREFIX } from "./viewer.ts";

/** The bridge's viewer address (LA-1: slice `bridge.viewUrl`, SDK `ctx.viewUrl`). Read tolerantly: an SDK without the
 *  field gives undefined → null → view_origin_missing. */
export function viewUrlOf(ctx: object): string | null {
  const v = (ctx as { viewUrl?: unknown }).viewUrl;
  // host[:port] only: the value goes into CSP headers (review PR #2, finding 11)
  return typeof v === "string" && /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(v) ? v : null;
}

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const COMPANIONS = companionOps(manifest);

/** Injected clock (tests set it; CON-11: no wall-clock waits in tests). */
let clock: () => number = Date.now;
export function setClock(fn: () => number): void {
  clock = fn;
}

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

const OWNER_NAME = "Owner";
export function actorOf(ctx: Pick<OpContext, "caller">): Actor {
  const c = ctx.caller;
  if (c.type === "person") return { type: "person", id: c.id, name: OWNER_NAME };
  return { type: c.type, id: c.id, name: c.name };
}

/** The app DB for `scope()` resolvers (bound once in onStart; `scope()` gets no context). */
let scopeDb: Db | null = null;
export function bindScopeDb(db: Db | null): void {
  scopeDb = db;
}
/** A gallery id nobody holds (ids are agent/app ids or "shared"; `#` is outside the gallery id pattern). */
export const NO_GALLERY = "#missing";
/** Gallery that owns an artifact, so the SDK checks access to THAT gallery before any hold. A missing artifact maps to a
 *  gallery nobody holds: the SDK refuses it exactly like an existing artifact in a gallery the caller cannot reach
 *  (scope_denied, no hold), so the answer reveals nothing (review PR #1, finding 1). */
function galleryOfArtifact(id: string): string | null {
  if (!scopeDb) return null;
  const r = artifactRow(scopeDb, id);
  return r ? String(r.gallery_id) : NO_GALLERY;
}
/** Free text after trim must not be empty (the schema checks only the raw length). */
function text(v: string, field: string): string {
  const t = v.trim();
  if (!t) throw new TbError(`${field}_empty`, `${field} is empty`, 400);
  return t;
}

/** Make sure an agent's or app's own gallery exists (idempotent upsert on every call, KAN-01). */
async function prepare(ctx: OpContext): Promise<Actor> {
  const a = actorOf(ctx);
  if (a.type === "person") return a;
  const own = (await ctx.scopes.instances.list(GALLERY)).some((i) => i.id === a.id);
  if (!own) await ctx.scopes.instances.create(GALLERY, a.id, `${a.name} pages`.slice(0, 80), { ownerAgent: a.id as never });
  return a;
}

async function needArtifact(ctx: OpContext, id: string, crud: CrudAction): Promise<Record<string, unknown>> {
  const r = artifactRow(ctx.db, id);
  if (!r || !(await ctx.scope.can(GALLERY, String(r.gallery_id), "read"))) throw notFound();
  if (crud !== "read" && !(await ctx.scope.can(GALLERY, String(r.gallery_id), crud))) throw new TbError("scope_denied", `no ${crud} access to this gallery`, 403);
  return r;
}
async function needGallery(ctx: OpContext, gallery: string, crud: CrudAction): Promise<void> {
  const exists = (await ctx.scopes.instances.list(GALLERY)).some((i) => i.id === gallery);
  if (!exists || !(await ctx.scope.can(GALLERY, gallery, "read"))) throw new TbError("gallery_not_found", "no such gallery", 404);
  if (crud !== "read" && !(await ctx.scope.can(GALLERY, gallery, crud))) throw new TbError("scope_denied", `no ${crud} access to this gallery`, 403);
}
async function accessLevel(ctx: OpContext, gallery: string): Promise<string> {
  if (ctx.caller.type === "person") return "manage";
  if (await ctx.scope.can(GALLERY, gallery, "delete")) return "manage";
  if (await ctx.scope.can(GALLERY, gallery, "create")) return "contribute";
  return "read";
}
async function galleriesOf(ctx: OpContext) {
  const readable = new Set(await ctx.scope.readable(GALLERY));
  const all = (await ctx.scopes.instances.list(GALLERY)).filter((i) => readable.has(i.id));
  const counts = countByGallery(
    ctx.db,
    all.map((g) => g.id),
  );
  const out = [];
  for (const g of all) out.push({ id: g.id, label: g.label, access: await accessLevel(ctx, g.id), shared: g.shared, artifactCount: counts.get(g.id) ?? 0 });
  return out;
}

/** HTML lint: errors refuse the write, advice comes back with the result. */
function checkHtml(html: string | undefined): LintItem[] {
  if (html === undefined) return [];
  const items = lintHtml(html);
  const errors = lintErrors(items);
  if (errors.length > 0) throw new TbError("view_lint_failed", errors.map((e) => `${e.code}: ${e.message}`).join(" "), 400);
  return items;
}
function checkView(view: { html: string; site?: unknown } | undefined): string | undefined {
  if (view?.site !== undefined) throw new TbError("unsupported_in_this_version", "view.site (multi-file sites) is not supported in this version (planned: version 0.4)", 400);
  return view?.html;
}
/** R1 ops (DESIGN §3.0): a present rules.narrowing cannot be honoured (snapshots carry no tags) → fail closed. */
function refuseNarrowing(ctx: OpContext): void {
  if (ctx.context["rules.narrowing"] !== undefined) throw new TbError("narrowing_unsupported", "Live Artifacts data cannot be filtered by memory tags", 409);
}
function review(ctx: OpContext, id: string) {
  const r = artifactRow(ctx.db, id);
  const pending = sourcesOf(ctx.db, id).filter((s) => s.kind === "read" && !s.approved).length;
  return { sourcesPending: pending, triggerPending: String(r?.refresh_state) === "waiting_approval", ownerLink: ctx.ownerLink(`/page/${id}`) };
}
const sayArtifact = (i: { id: string }) => `page ${i.id}`;

export const handlers = {
  // ───────────────────────────────────────────── agent ops
  [OP.galleriesList]: op<GalleriesListInput, unknown>({
    scope: () => null,
    async run(_i, ctx) {
      await prepare(ctx);
      return { galleries: await galleriesOf(ctx) };
    },
  }),
  [OP.artifactList]: op<ArtifactListInput, unknown>({
    scope: (i) => i.gallery ?? null,
    async run(i, ctx) {
      await prepare(ctx);
      const galleries = i.gallery ? [i.gallery] : await ctx.scope.readable(GALLERY);
      return listArtifacts(
        ctx.db,
        { galleries, ...(i.status ? { status: i.status } : {}), ...(i.q ? { q: i.q } : {}), limit: i.limit ?? LIMITS.listDefault, ...(i.cursor ? { cursor: i.cursor } : {}) },
        clock(),
      );
    },
  }),
  [OP.artifactGet]: op<ArtifactGetInput, unknown>({
    scope: () => null,
    async run(i, ctx) {
      await prepare(ctx);
      const include = new Set(i.include ?? []);
      if (include.has("data")) refuseNarrowing(ctx);
      const a = await needArtifact(ctx, i.id, "read");
      const n = i.version ?? Number(a.live_version);
      const v = versionRow(ctx.db, i.id, n);
      if (!v) throw new TbError("version_unknown", `version ${n} does not exist (it may have been pruned)`, 404);
      const now = clock();
      return {
        artifact: toDetail(ctx.db, a, now),
        version: versionOut(v),
        ...(include.has("versions") ? { versions: versionsOf(ctx.db, a) } : {}),
        ...(include.has("sources") ? { sources: sourcesOf(ctx.db, i.id) } : {}),
        ...(include.has("links") ? { links: linksOf(ctx.db, i.id, now) } : {}),
        ...(include.has("shape") ? { shape: shapesOf(ctx.db, i.id) } : {}),
        ...(include.has("data") ? { data: pushedDataOf(ctx.db, i.id) } : {}),
      };
    },
  }),
  [OP.artifactCreate]: op<ArtifactCreateInput, unknown>({
    scope: (i, c) => i.gallery ?? c.id,
    redact: (i) => `page "${i.title.slice(0, 80)}"`,
    async run(i, ctx) {
      const by = await prepare(ctx);
      const gallery = i.gallery ?? by.id;
      await needGallery(ctx, gallery, "create");
      let html = checkView(i.view);
      let contract = normalizeContract(i.contract as RawContract | undefined, COMPANIONS);
      let forkedFrom: string | null = null;
      if (i.fromId) {
        const src = await needArtifact(ctx, i.fromId, "read");
        const v = versionRow(ctx.db, i.fromId, i.fromVersion ?? Number(src.live_version));
        if (!v) throw new TbError("version_unknown", "the version to copy does not exist", 404);
        html ??= Buffer.from(v.html as Uint8Array).toString("utf8");
        if (i.contract === undefined) contract = parseStoredContract(String(v.contract_json)); // copied bindings start pending (new rows)
        forkedFrom = i.fromId;
      }
      if (html === undefined) throw new TbError("view_missing", "give view.html, or fromId to copy a page", 400);
      const lint = checkHtml(html);
      const r = createArtifact(
        ctx.db,
        {
          gallery,
          title: text(i.title, "title"),
          description: (i.description ?? "").trim(),
          contract,
          html,
          note: i.note ?? "",
          by,
          origin: forkedFrom ? { kind: "copy", ref: forkedFrom } : { kind: by.type === "app" ? "app" : "agent", ref: by.type === "app" ? by.name : null },
          forkedFrom,
        },
        clock(),
      );
      ctx.statusChanged();
      return { id: r.id, gallery, version: r.version, liveVersion: r.version, review: review(ctx, r.id), lint };
    },
  }),
  [OP.artifactUpdate]: op<ArtifactUpdateInput, unknown>({
    scope: () => null,
    redact: sayArtifact,
    async run(i, ctx) {
      const by = await prepare(ctx);
      await needArtifact(ctx, i.id, "update");
      const html = checkView(i.view);
      const lint = checkHtml(html);
      const contract = i.contract === undefined ? undefined : normalizeContract(i.contract as RawContract, COMPANIONS);
      const r = updateArtifact(
        ctx.db,
        i.id,
        {
          ...(i.expectedVersion !== undefined ? { expectedVersion: i.expectedVersion } : {}),
          ...(i.title !== undefined ? { title: text(i.title, "title") } : {}),
          ...(i.description !== undefined ? { description: i.description.trim() } : {}),
          ...(contract ? { contract } : {}),
          ...(html !== undefined ? { html } : {}),
          note: i.note ?? "",
          by,
        },
        clock(),
      );
      ctx.statusChanged();
      return { id: i.id, ...r, review: review(ctx, i.id), lint };
    },
  }),
  [OP.artifactDelete]: op<ArtifactDeleteInput, unknown>({
    scope: (i) => galleryOfArtifact(i.id),
    redact: sayArtifact,
    holdView: (i) => {
      const r = scopeDb ? artifactRow(scopeDb, i.id) : undefined;
      return r ? `Delete the live page "${String(r.title)}" with all its versions, data and links.` : `Delete the live page ${i.id}.`;
    },
    async run(i, ctx) {
      const by = await prepare(ctx);
      await needArtifact(ctx, i.id, "delete");
      const r = deleteArtifact(ctx.db, i.id, by, clock());
      ctx.statusChanged();
      return r;
    },
  }),
  [OP.artifactDataPut]: op<ArtifactDataPutInput, unknown>({
    scope: () => null,
    redact: (i) => `page ${i.id} data ${i.key}`,
    async run(i, ctx) {
      const by = await prepare(ctx);
      await needArtifact(ctx, i.id, "update");
      return putData(ctx.db, i.id, i.key, i.data as Json, by, clock());
    },
  }),

  [OP.artifactRefresh]: op<ArtifactRefreshInput, unknown>({
    scope: () => null,
    redact: (i) => `refresh page ${i.id}`,
    async run(i, ctx) {
      await prepare(ctx);
      const a = await needArtifact(ctx, i.id, "update");
      if (String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; the owner can restore it", 409);
      const now = clock();
      const last = a.manual_refresh_at === null ? null : Number(a.manual_refresh_at);
      if (last !== null && now - last < LIMITS.manualRefreshMs)
        throw new TbError("refresh_rate_limited", `one refresh per minute per page; try again in ${Math.ceil((LIMITS.manualRefreshMs - (now - last)) / 1000)} s`, 429);
      ctx.db.prepare("UPDATE la_artifact SET manual_refresh_at = ? WHERE id = ?").run(now, i.id);
      // the reads use this app's own read-only companion grant; the agent gets the status per source, never the data
      const out = await refreshArtifact(ctx.db, ctx.callApp as never, i.id, { slot: `manual:${Math.floor(now / LIMITS.manualRefreshMs)}`, ...(i.keys ? { keys: i.keys } : {}), now: clock });
      return { results: out.results };
    },
  }),

  // ───────────────────────────────────────────── owner ops
  [OP.galleryView]: op<GalleryViewInput, unknown>({
    async run(i, ctx) {
      const galleries = await galleriesOf(ctx);
      const ids = i.gallery ? [i.gallery] : galleries.map((g) => g.id);
      const now = clock();
      const page = listArtifacts(ctx.db, { galleries: ids, filter: i.filter ?? "all", limit: LIMITS.listMax, ...(i.cursor ? { cursor: i.cursor } : {}) }, now);
      const count = (filter: "all" | "review" | "shared" | "stale" | "archived") =>
        listArtifacts(ctx.db, { galleries: ids, filter, limit: LIMITS.artifactsPerWorkspace }, now).items.length;
      const notices: { code: string; message: string }[] = [];
      if (!ctx.publicUrl) notices.push({ code: "bridge_url_missing", message: "The bridge address is not known yet. Review links appear when it is." });
      return {
        galleries,
        items: page.items,
        nextCursor: page.nextCursor,
        counts: { all: count("all"), review: count("review"), shared: count("shared"), stale: count("stale"), archived: count("archived") },
        notices,
        settings: getSettings(ctx.db),
      };
    },
  }),
  [OP.artifactDetail]: op<ArtifactDetailInput, unknown>({
    async run(i, ctx) {
      const a = artifactRow(ctx.db, i.id);
      if (!a) throw notFound();
      const n = i.version ?? Number(a.live_version);
      const v = versionRow(ctx.db, i.id, n);
      if (!v) throw new TbError("version_unknown", `version ${n} does not exist`, 404);
      const now = clock();
      return {
        artifact: toDetail(ctx.db, a, now),
        version: versionOut(v),
        versions: versionsOf(ctx.db, a),
        sources: sourcesOf(ctx.db, i.id),
        links: linksOf(ctx.db, i.id, now),
        activity: activityOf(ctx.db, i.id),
      };
    },
  }),
  [OP.artifactPreviewTicket]: op<ArtifactPreviewTicketInput, unknown>({
    async run(i, ctx) {
      const view = viewUrlOf(ctx);
      if (!view) throw new TbError("view_origin_missing", "The bridge has no viewer address yet. Ask Portal to redeploy the bridge.", 409);
      if (!artifactRow(ctx.db, i.id)) throw notFound();
      if (i.version !== undefined && !versionRow(ctx.db, i.id, i.version)) throw new TbError("version_unknown", `version ${i.version} does not exist`, 404);
      const p = createPreview(ctx.db, i.id, i.version ?? null, actorOf(ctx), clock());
      return { url: `${view}${VIEW_PREFIX}/${p.token}`, version: p.version, expiresAt: new Date(p.expiresAt).toISOString() };
    },
  }),
  [OP.sourceTest]: op<SourceTestInput, unknown>({
    async run(i, ctx) {
      const src = ctx.db.prepare("SELECT * FROM la_source WHERE artifact_id = ? AND key = ?").get(i.id, i.key);
      if (!src) throw new TbError("source_unknown", `the page has no source "${i.key}"`, 404);
      if (String(src.kind) !== "read") return { key: i.key, status: "not_read", sample: null, rows: null, code: "push_source", configureLink: null };
      const product = String(src.product);
      try {
        const r = (await ctx.callApp(product, String(src.op), JSON.parse(String(src.input_json ?? "{}")) as Json)) as { status: string; output?: Json; holdId?: string };
        if (r.status === "held") return { key: i.key, status: "held", sample: null, rows: null, code: r.holdId ?? null, configureLink: null };
        const v = project(r.output ?? null, JSON.parse(String(src.projection_json ?? "{}")));
        if (v === undefined) return { key: i.key, status: "error", sample: null, rows: null, code: "projection_empty", configureLink: null };
        const rows = Array.isArray(v) ? v.length : null;
        return { key: i.key, status: "ok", sample: Array.isArray(v) ? v.slice(0, LIMITS.sampleRows) : v, rows, code: null, configureLink: null };
      } catch (e) {
        const code = e instanceof TbError ? e.code : "refresh_error";
        // scope_denied: the source app does not share that data with this app yet → link to its Configure page
        return { key: i.key, status: "error", sample: null, rows: null, code, configureLink: code === "scope_denied" ? (ctx as unknown as SdkOpContext).ownerLinkFor(product, "/configure") : null };
      }
    },
  }),
  [OP.sourceApprove]: op<SourceApproveInput, unknown>({
    redact: (i) => `page ${i.id} source ${i.key} approved (viewers ${i.viewers ? "on" : "off"})`,
    async run(i, ctx) {
      return ctx.db.transaction(() => {
        const src = ctx.db.prepare("SELECT digest FROM la_source WHERE artifact_id = ? AND key = ?").get(i.id, i.key);
        if (!src) throw new TbError("source_unknown", `the page has no source "${i.key}"`, 404);
        if (String(src.digest) !== i.digest) throw new TbError("digest_changed", "this source changed since you looked at it; review it again", 409);
        ctx.db
          .prepare("UPDATE la_source SET approved_digest = digest, approved_by = ?, approved_at = ?, viewers = ? WHERE artifact_id = ? AND key = ?")
          .run(ctx.caller.id, clock(), i.viewers ? 1 : 0, i.id, i.key);
        return { key: i.key, approved: true, viewers: i.viewers };
      });
    },
  }),
  [OP.sourceRevoke]: op<SourceRevokeInput, unknown>({
    redact: (i) => `page ${i.id} source ${i.key} revoked`,
    async run(i, ctx) {
      return ctx.db.transaction(() => {
        const r = ctx.db.prepare("UPDATE la_source SET approved_digest = NULL, approved_by = NULL, approved_at = NULL, viewers = 0 WHERE artifact_id = ? AND key = ?").run(i.id, i.key);
        if (r.changes === 0) throw new TbError("source_unknown", `the page has no source "${i.key}"`, 404);
        ctx.db.prepare("DELETE FROM la_snapshot WHERE artifact_id = ? AND key = ?").run(i.id, i.key);
        return { key: i.key, approved: false };
      });
    },
  }),
  [OP.triggerApprove]: op<TriggerApproveInput, unknown>({
    redact: (i) => `page ${i.id} refresh ${i.everySeconds === null ? "off" : `every ${i.everySeconds} s`}`,
    async run(i, ctx) {
      const jobs = (ctx as unknown as { jobs: JobsApi }).jobs;
      const a = artifactRow(ctx.db, i.id);
      if (!a) throw notFound();
      const now = clock();
      const old = a.refresh_job_id === null ? null : String(a.refresh_job_id);
      if (old) {
        const j = jobs.get(old);
        if (j && ["queued", "waiting", "running", "paused"].includes(j.status)) jobs.cancel(old);
      }
      if (i.everySeconds === null) {
        ctx.db.prepare("UPDATE la_artifact SET refresh_approved = 0, refresh_state = 'off', next_refresh_at = NULL, refresh_job_id = NULL WHERE id = ?").run(i.id);
      } else {
        if (String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; restore it first", 409);
        // enqueued by the OWNER: the schedule does not depend on the agent that made the page (DESIGN O6)
        const job = jobs.enqueue(REFRESH_JOB, { id: i.id });
        ctx.db
          .prepare("UPDATE la_artifact SET refresh_every_s = ?, refresh_approved = 1, refresh_state = 'on', consecutive_failures = 0, next_refresh_at = ?, refresh_job_id = ? WHERE id = ?")
          .run(i.everySeconds, now, job.id, i.id);
      }
      ctx.statusChanged();
      return { id: i.id, refresh: toDetail(ctx.db, artifactRow(ctx.db, i.id) ?? a, now).refresh };
    },
  }),
  [OP.publishVersion]: op<PublishVersionInput, unknown>({
    redact: (i) => `page ${i.id} version ${i.version}`,
    async run(i, ctx) {
      const r = publishVersion(ctx.db, i.id, i.version, i.data ?? true, actorOf(ctx), clock());
      ctx.statusChanged();
      return r;
    },
  }),
  [OP.autopublishSet]: op<AutopublishSetInput, unknown>({
    redact: (i) => `page ${i.id} autopublish ${i.mode}`,
    async run(i, ctx) {
      setAutoPublish(ctx.db, i.id, i.mode, actorOf(ctx), clock());
      return { id: i.id, autoPublish: i.mode };
    },
  }),
  [OP.artifactArchive]: op<ArtifactArchiveInput, unknown>({
    redact: (i) => `page ${i.id} ${i.archived ? "archive" : "restore"}`,
    async run(i, ctx) {
      return { id: i.id, status: setArchived(ctx.db, i.id, i.archived, actorOf(ctx), clock()) };
    },
  }),
  [OP.artifactRemove]: op<ArtifactRemoveInput, unknown>({
    redact: sayArtifact,
    async run(i, ctx) {
      if (!artifactRow(ctx.db, i.id)) throw notFound();
      const r = deleteArtifact(ctx.db, i.id, actorOf(ctx), clock());
      ctx.statusChanged();
      return r;
    },
  }),
  [OP.settingsSet]: op<SettingsSetInput, unknown>({
    redact: (i) => `default link lifetime ${i.defaultLinkDays} days`,
    async run(i, ctx) {
      return setSettings(ctx.db, { defaultLinkDays: i.defaultLinkDays });
    },
  }),
  [OP.artifactNew]: op<ArtifactNewInput, unknown>({
    redact: (i) => `page "${i.title.slice(0, 80)}"`,
    async run(i, ctx) {
      const gallery = i.gallery ?? SHARED_GALLERY;
      if (!(await ctx.scopes.instances.list(GALLERY)).some((g) => g.id === gallery)) throw new TbError("gallery_not_found", "no such gallery", 404);
      const lint = checkHtml(i.html);
      const r = createArtifact(
        ctx.db,
        { gallery, title: text(i.title, "title"), description: (i.description ?? "").trim(), contract: EMPTY_CONTRACT, html: i.html, note: "", by: actorOf(ctx), origin: { kind: "owner", ref: null }, forkedFrom: null },
        clock(),
      );
      ctx.statusChanged();
      return { id: r.id, gallery, version: r.version, lint };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

/** One refresh tick of one artifact (SDK handler job). Returns the next run, or ends when the schedule is off. */
export async function refreshTick(input: Json, ctx: JobContext): Promise<{ status: "done" } | { status: "again"; afterMs: number }> {
  const id = String((input as { id?: string })?.id ?? "");
  const a = artifactRow(ctx.db, id);
  // ends quietly when the page is gone, archived, switched off, or this job is no longer the page's job
  if (!a || String(a.status) !== "active" || Number(a.refresh_approved) !== 1 || String(a.refresh_job_id) !== ctx.job.id) return { status: "done" };
  const every = Number(a.refresh_every_s);
  const now = clock();
  let next: { state: string; nextAt: number | null } = { state: "on", nextAt: now + every * 1000 };
  await refreshArtifact(ctx.db, ctx.callApp as never, id, {
    slot: `s${Math.floor(now / (every * 1000))}`,
    now: clock,
    write: (fn) => ctx.checkpoint({ at: now }, fn),
    after: (o, at) => {
      next = recordTick(ctx.db, id, o, at);
    },
  });
  ctx.statusChanged();
  if (next.state === "paused_error" || next.nextAt === null) return { status: "done" };
  return { status: "again", afterMs: Math.max(1000, next.nextAt - clock()) };
}

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  jobs: { [REFRESH_JOB]: { run: refreshTick as never, maxAttempts: 3, leaseMs: 120_000, timeoutMs: 5 * 60_000 } },
  // the page needs the owner when a refresh stopped after repeated failures (L3: a stop is never silent)
  // An app attention() replaces the SDK's jobs_failed/jobs_stuck default, so this one covers both: pages that stopped after
  // repeated failures, and approved schedules that are more than 10 minutes overdue (a failed or lost job).
  async attention(db) {
    const now = clock();
    const stopped = Number(db.prepare("SELECT COUNT(*) AS c FROM la_artifact WHERE status = 'active' AND refresh_state = 'paused_error'").get()?.c ?? 0);
    const overdue = Number(
      db.prepare("SELECT COUNT(*) AS c FROM la_artifact WHERE status = 'active' AND refresh_approved = 1 AND refresh_state = 'on' AND next_refresh_at < ?").get(now - 600_000)?.c ?? 0,
    );
    if (stopped > 0) return { code: "refresh_stopped", reason: `${stopped} live page(s) stopped refreshing after repeated failures` };
    if (overdue > 0) return { code: "refresh_overdue", reason: `${overdue} live page(s) are more than 10 minutes late to refresh` };
    return null;
  },
  async onStart(ctx) {
    bindScopeDb(ctx.db);
    await ctx.scopes.instances.create(GALLERY, SHARED_GALLERY, "Shared", { shared: true });
  },
  events: {
    // First sight of an agent (SDK-API §7.2): create its own gallery; the SDK then applies defaultGrants (own → manage).
    async agentAdded(agent, ctx) {
      await ctx.scopes.instances.create(GALLERY, agent.id, `${agent.name} pages`.slice(0, 80), { ownerAgent: agent.id });
    },
  },
  // Items waiting for the owner beyond held receipts: pages with sources or a schedule to approve, or a staged version.
  async pendingCount(db) {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS c FROM la_artifact a WHERE a.status = 'active' AND (a.staged_version IS NOT NULL OR a.refresh_state = 'waiting_approval'
           OR EXISTS (SELECT 1 FROM la_source s WHERE s.artifact_id = a.id AND s.kind = 'read' AND (s.approved_digest IS NULL OR s.approved_digest <> s.digest)))`,
      )
      .get();
    return Number(r?.c ?? 0);
  },
};

export const app = defineApp(definition);
