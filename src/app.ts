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
import { type AppDefinition, type Db, defineApp, type HandlerSpec, type Json, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type ArtifactArchiveInput,
  type ArtifactCreateInput,
  type ArtifactDataPutInput,
  type ArtifactDeleteInput,
  type ArtifactDetailInput,
  type ArtifactGetInput,
  type ArtifactListInput,
  type ArtifactNewInput,
  type ArtifactRemoveInput,
  type ArtifactUpdateInput,
  type AutopublishSetInput,
  type GalleriesListInput,
  type GalleryViewInput,
  OP,
  type OpId,
  type PublishVersionInput,
  type SettingsSetInput,
} from "#kit";
import { companionOps, EMPTY_CONTRACT, normalizeContract, parseStoredContract, type RawContract } from "./contract.ts";
import { LIMITS } from "./limits.ts";
import { type LintItem, lintErrors, lintHtml } from "./lint.ts";
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
/** Gallery that owns an artifact; a missing artifact answers not_found before authorize (no hold, no receipt). */
function galleryOfArtifact(id: string): string | null {
  if (!scopeDb) return null;
  const r = artifactRow(scopeDb, id);
  if (!r) throw notFound();
  return String(r.gallery_id);
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
          title: i.title.trim(),
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
          ...(i.title !== undefined ? { title: i.title.trim() } : {}),
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
        { gallery, title: i.title.trim(), description: (i.description ?? "").trim(), contract: EMPTY_CONTRACT, html: i.html, note: "", by: actorOf(ctx), origin: { kind: "owner", ref: null }, forkedFrom: null },
        clock(),
      );
      ctx.statusChanged();
      return { id: r.id, gallery, version: r.version, lint };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
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
