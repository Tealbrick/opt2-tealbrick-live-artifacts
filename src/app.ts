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
import { type CrudAction, digest } from "@opt2-tealbrick/manifest";
import type { JobContext, JobsApi } from "@opt2-tealbrick/miniapp-sdk";
import {
  type AppDefinition,
  type Db,
  defineApp,
  type HandlerSpec,
  type Json,
  type OpContext,
  type PublicHandler,
  requireViewUrl,
  type SdkAppDefinition,
  type SdkOpContext,
  TbError,
  viewOriginMissing,
} from "@opt2-tealbrick/miniapp-sdk";
import {
  type ArtifactArchiveInput,
  type ArtifactCreateInput,
  type ArtifactDataPutInput,
  type ArtifactDeleteInput,
  type ArtifactDetailInput,
  type ArtifactGetInput,
  type ArtifactLinkRevokeInput,
  type ArtifactListInput,
  type ArtifactNewInput,
  type ArtifactPreviewTicketInput,
  type ArtifactPublishInput,
  type ArtifactRefreshInput,
  type ArtifactRemoveInput,
  type ArtifactShareInput,
  type ArtifactUpdateInput,
  type AutopublishSetInput,
  type GalleriesListInput,
  type GalleryViewInput,
  type LinkCreateInput,
  type LinkRevokeInput,
  type LinksListInput,
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
import { flagHold, holdFlagged, shareExpectOf, shareMismatch } from "./expect.ts";
import { LIMITS } from "./limits.ts";
import { createLink, galleryOfLink, listLinks, publishHoldText, publishMismatch, revokeLink, shareHoldText } from "./links.ts";
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
import { createPreview, endLinksAfterRestore, ensureDocKey, handleViewer, httpsOrigin, recordRestore, restoreUnhandled, VIEW_PREFIX, type ViewerConfig } from "./viewer.ts";

/** The viewer address of the bridge (LA-1: slice `bridge.viewUrl`, SDK `ctx.viewUrl`). The SDK's requireViewUrl answers 409
 *  view_origin_missing while there is none; it checks only that the string is not empty, so the https host check stays here
 *  (the value goes into CSP headers and addresses). */
function viewBase(ctx: object): string {
  const url = httpsOrigin(requireViewUrl(ctx as { viewUrl?: string | null }));
  if (url === null) throw viewOriginMissing();
  return url;
}

/** The last viewer address any call saw (null = missing, undefined = no call yet). A hold view gets only the input, no
 *  context, so this is how the hold text can say the page cannot be shared yet (best effort; the call itself is refused
 *  with view_origin_missing when it runs). Every handler that has a context reports it here. */
let viewUrlSeen: string | null | undefined;
function noteViewUrl(ctx: object): void {
  viewUrlSeen = httpsOrigin((ctx as { viewUrl?: unknown }).viewUrl);
}

/** Banner text of the viewer shell ("Shared by <this> · written by an AI agent"). The slice carries no workspace name. */
const VIEWER_WORKSPACE = "the owner of this workspace";
/** The main origin of the bridge, from the slice (`bridge.publicUrl`); previews may be framed from there. */
function mainOriginOf(publicUrl: unknown): string | null {
  try {
    return typeof publicUrl === "string" ? httpsOrigin(new URL(publicUrl).origin) : null;
  } catch {
    return null;
  }
}

/** The viewer route (manifest `publicRoutes` `/v`, purpose `viewer`, MANIFEST M-PR-2). The SDK serves GET /v/live-artifacts/…
 *  only, answers 503 while the instance is paused, passes the allow-listed request headers, forces VIEWER_HEADER_FLOOR and
 *  refuses a `_d` document whose CSP is not a safe sandbox; it hands us the path WITHOUT the `/v/live-artifacts` prefix. */
export const viewerRoute: PublicHandler = async (req, ctx) => {
  const cfg: ViewerConfig = {
    docKey: await ensureDocKey(ctx.secrets),
    viewOrigin: httpsOrigin(ctx.viewUrl),
    mainOrigin: mainOriginOf(ctx.publicUrl),
    workspaceName: VIEWER_WORKSPACE,
  };
  return handleViewer(ctx.db, req, cfg, clock());
};

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
/** The calling app as the SDK VERIFIED it (Caller.product, from the signed companionCallers entry; SDK 0.1.27). Never the
 *  display name, which is the caller's own manifest name. Only provenance: nothing here is decided by a caller's identity. */
const appProduct = (ctx: Pick<OpContext, "caller">): string => String((ctx.caller as { product?: string }).product ?? "unknown");
export function actorOf(ctx: Pick<OpContext, "caller">): Actor {
  const c = ctx.caller;
  if (c.type === "person") return { type: "person", id: c.id, name: OWNER_NAME };
  return { type: c.type, id: c.id, name: c.name };
}

/** The app DB for `scope()` resolvers (bound once in onStart; `scope()` gets no context). */
let scopeDb: Db | null = null;
export function bindScopeDb(db: Db | null): void {
  scopeDb = db;
  viewUrlSeen = undefined;
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
  noteViewUrl(ctx);
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
/** Receipt text for a link op: the page title, never an address or a token. */
const titleOf = (id: string): string => String((scopeDb ? artifactRow(scopeDb, id)?.title : undefined) ?? id).slice(0, 80);

/** S4 review F3 (final): a link request that is not the page as it is now gets NO early refusal for anybody. The SDK
 *  resolves the scope (`scope()`), then decides pause, grant, scope access and the hold (`authorize`), and only then runs the
 *  handler; a refusal inside `scope()` would come before the access check and the pause check and would tell a caller that
 *  lost its access, or a paused agent, whether a page exists and what it looks like. So the request goes through the SDK
 *  checks first (scope_denied, paused: the same answers as for an unknown page), and if it passes it becomes a hold that
 *  starts with "Do not approve" and whose input is flagged, so even an approval of it is refused when it runs. */
/** Render side of F3: remember an input whose hold was rendered on a mismatch. A write that fails is NOT swallowed: the
 *  hold view throws, the SDK creates no hold (the call fails with an internal error), so a hold that cannot be flagged
 *  can never be approved. */
function flagMismatch(input: Json, diff: string[]): void {
  if (diff.length === 0 || !scopeDb) return;
  flagHold(scopeDb, digest(input), clock());
}
/** Run side of F3: an approved hold that was rendered on a mismatch never runs. */
function refuseFlagged(db: Db, input: Json): void {
  if (holdFlagged(db, digest(input))) throw new TbError("page_changed", "the owner was told not to approve this request (it did not match the page); ask again with the page as it is now", 409);
}

/** DESIGN §3.1, spec PORTAL-API (hold family public_link): an app that offers links refuses an AGENT (or app) link op when
 *  the verified grant does not hold `public_link`, until the owner accepts the offer. Fail closed: no grant, or a grant
 *  without the family in `held`, is a refusal. The SDK holds the call when the family IS in `held`; this guard is for the
 *  grant that would otherwise run the op straight away. The owner's own calls are not held. */
function needLinkHold(ctx: OpContext): void {
  if (ctx.caller.type === "person") return;
  const held = ctx.grant?.claims.held;
  if (!Array.isArray(held) || !held.includes("public_link"))
    throw new TbError("link_needs_hold", "A public link needs the owner's approval, and this agent's card does not hold public_link. Ask the owner to accept the public_link offer in Portal.", 403);
}

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
        // what artifact_share needs as `expect` for a link that shows this version (copy it as it is)
        shareExpect: shareExpectOf(ctx.db, i.id, n),
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
          origin: forkedFrom ? { kind: "copy", ref: forkedFrom } : { kind: by.type === "app" ? "app" : "agent", ref: by.type === "app" ? appProduct(ctx) : null },
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
      stopRefreshJob(ctx.db, (ctx as unknown as { jobs?: JobsApi }).jobs, i.id);
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
      // claim the one-per-minute slot atomically (two parallel calls cannot both pass; review PR #3, finding 3)
      const claimed = ctx.db
        .prepare("UPDATE la_artifact SET manual_refresh_at = ? WHERE id = ? AND (manual_refresh_at IS NULL OR manual_refresh_at <= ?)")
        .run(now, i.id, now - LIMITS.manualRefreshMs);
      if (Number(claimed.changes) !== 1) {
        const last = Number(artifactRow(ctx.db, i.id)?.manual_refresh_at ?? now);
        throw new TbError("refresh_rate_limited", `one refresh per minute per page; try again in ${Math.max(1, Math.ceil((LIMITS.manualRefreshMs - (now - last)) / 1000))} s`, 429);
      }
      // the reads use this app's own read-only companion grant; the agent gets the status per source, never the data
      const out = await refreshArtifact(ctx.db, ctx.callApp as never, i.id, {
        mode: "manual",
        slot: `m${Math.floor(now / LIMITS.manualRefreshMs)}`,
        ...(i.keys ? { keys: i.keys } : {}),
        now: clock,
        signal: (ctx as { signal?: AbortSignal }).signal,
      });
      return { results: out.results };
    },
  }),
  [OP.artifactShare]: op<ArtifactShareInput, unknown>({
    scope: (i) => galleryOfArtifact(i.id),
    redact: (i) => `share page "${titleOf(i.id)}" with a link`,
    holdView: (i) => {
      if (!scopeDb) return `Create a public link to the live page ${i.id}.`;
      flagMismatch(i as unknown as Json, shareMismatch(scopeDb, i.id, i.pin, i.expect));
      return shareHoldText(scopeDb, i, clock(), { viewerMissing: viewUrlSeen === null });
    },
    async run(i, ctx) {
      needLinkHold(ctx);
      refuseFlagged(ctx.db, i as unknown as Json);
      const base = viewBase(ctx);
      const by = await prepare(ctx);
      await needArtifact(ctx, i.id, "create");
      // the owner approved this exact page (version, sha256, title): refuse if it is another page now
      const link = createLink(ctx.db, { artifactId: i.id, label: (i.label ?? "").trim(), expiresInDays: i.expiresInDays, pin: i.pin, expect: i.expect, by }, clock());
      ctx.statusChanged();
      // the address is in this answer only (the SDK seals the idempotent answer for 24 h); the app keeps its digest
      return { linkId: link.id, url: `${base}${VIEW_PREFIX}/${link.token}`, expiresAt: new Date(link.expiresAt).toISOString() };
    },
  }),
  [OP.artifactPublish]: op<ArtifactPublishInput, unknown>({
    scope: (i) => galleryOfArtifact(i.id),
    redact: (i) => `page "${titleOf(i.id)}": version ${i.version} live${i.data?.length ? `, data ${i.data.map((d) => d.key).join(", ")}` : ""}`,
    holdView: (i) => {
      if (!scopeDb) return `Change what the people who hold a link to ${i.id} see.`;
      flagMismatch(i as unknown as Json, publishMismatch(scopeDb, i));
      return publishHoldText(scopeDb, i, clock());
    },
    async run(i, ctx) {
      needLinkHold(ctx);
      refuseFlagged(ctx.db, i as unknown as Json);
      const by = await prepare(ctx);
      const a = await needArtifact(ctx, i.id, "update");
      if (String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; the owner can restore it", 409);
      const data = i.data ?? [];
      if (i.version === Number(a.live_version) && data.length === 0 && i.expect.title === undefined && i.expect.description === undefined)
        throw new TbError("nothing_to_publish", `version ${i.version} is live already and you listed no staged data, title or description`, 409);
      // a staged title or description moves only when listed in expect (and shown in the hold); the rest stays staged
      const r = publishVersion(ctx.db, i.id, i.version, data, by, clock(), i.expect);
      ctx.statusChanged();
      return r;
    },
  }),
  [OP.artifactLinkRevoke]: op<ArtifactLinkRevokeInput, unknown>({
    // the gallery of the link's page, so the SDK checks update access to THAT gallery (unknown link = a gallery nobody holds)
    scope: (i) => (scopeDb ? galleryOfLink(scopeDb, i.linkId, NO_GALLERY) : null),
    redact: (i) => `revoke link ${i.linkId}`,
    async run(i, ctx) {
      // no needLinkHold: agents may always narrow who can see a page (DESIGN §3.1)
      const by = await prepare(ctx);
      const l = ctx.db.prepare("SELECT artifact_id FROM la_link WHERE id = ? AND kind = 'viewer'").get(i.linkId);
      if (!l) throw new TbError("link_not_found", "no such link", 404);
      await needArtifact(ctx, String(l.artifact_id), "update");
      const r = revokeLink(ctx.db, i.linkId, by, clock());
      ctx.statusChanged();
      return { revoked: r.revoked };
    },
  }),

  // ───────────────────────────────────────────── owner ops
  [OP.galleryView]: op<GalleryViewInput, unknown>({
    async run(i, ctx) {
      noteViewUrl(ctx);
      const galleries = await galleriesOf(ctx);
      const ids = i.gallery ? [i.gallery] : galleries.map((g) => g.id);
      const now = clock();
      const page = listArtifacts(ctx.db, { galleries: ids, filter: i.filter ?? "all", limit: LIMITS.listMax, ...(i.cursor ? { cursor: i.cursor } : {}) }, now);
      const count = (filter: "all" | "review" | "shared" | "stale" | "archived") =>
        listArtifacts(ctx.db, { galleries: ids, filter, limit: LIMITS.artifactsPerWorkspace }, now).items.length;
      const notices: { code: string; message: string }[] = [];
      if (!ctx.publicUrl) notices.push({ code: "bridge_url_missing", message: "The bridge address is not known yet. Review links appear when it is." });
      if (httpsOrigin((ctx as { viewUrl?: unknown }).viewUrl) === null) notices.push({ code: "view_origin_missing", message: "Links and previews need the viewer address. Ask Portal to redeploy the bridge." });
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
        // the write-time lint of this version, for step 1 of the owner's review (advice; errors were refused at write)
        lint: lintHtml(Buffer.from(v.html as Uint8Array).toString("utf8")),
      };
    },
  }),
  [OP.artifactPreviewTicket]: op<ArtifactPreviewTicketInput, unknown>({
    async run(i, ctx) {
      const view = viewBase(ctx);
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
        const src = ctx.db.prepare("SELECT digest, kind FROM la_source WHERE artifact_id = ? AND key = ?").get(i.id, i.key);
        if (!src) throw new TbError("source_unknown", `the page has no source "${i.key}"`, 404);
        if (String(artifactRow(ctx.db, i.id)?.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; restore it first", 409);
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
      // check BEFORE touching the job (review PR #3, finding 6)
      if (i.everySeconds !== null && String(a.status) !== "active") throw new TbError("artifact_archived", "this live page is archived; restore it first", 409);
      const now = clock();
      restartRefresh(ctx.db, jobs, i.id, i.everySeconds, now);
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
  [OP.linkCreate]: op<LinkCreateInput, unknown>({
    redact: (i) => `link for page "${titleOf(i.id)}"`,
    async run(i, ctx) {
      // the owner is the approver: no hold, no link_needs_hold (DESIGN §3.2)
      noteViewUrl(ctx);
      const base = viewBase(ctx);
      const link = createLink(ctx.db, { artifactId: i.id, label: (i.label ?? "").trim(), expiresInDays: i.expiresInDays, pin: i.pin, by: actorOf(ctx) }, clock());
      ctx.statusChanged();
      return { linkId: link.id, url: `${base}${VIEW_PREFIX}/${link.token}`, expiresAt: new Date(link.expiresAt).toISOString() };
    },
  }),
  [OP.linkRevoke]: op<LinkRevokeInput, unknown>({
    redact: (i) => `revoke link ${i.linkId}`,
    async run(i, ctx) {
      const r = revokeLink(ctx.db, i.linkId, actorOf(ctx), clock());
      ctx.statusChanged();
      return { revoked: r.revoked };
    },
  }),
  [OP.linksList]: op<LinksListInput, unknown>({
    async run(_i, ctx) {
      return listLinks(ctx.db, clock());
    },
  }),
  [OP.artifactArchive]: op<ArtifactArchiveInput, unknown>({
    redact: (i) => `page ${i.id} ${i.archived ? "archive" : "restore"}`,
    async run(i, ctx) {
      const jobs = (ctx as unknown as { jobs?: JobsApi }).jobs;
      const status = setArchived(ctx.db, i.id, i.archived, actorOf(ctx), clock());
      const a = artifactRow(ctx.db, i.id);
      if (i.archived) stopRefreshJob(ctx.db, jobs, i.id);
      else if (jobs && a && Number(a.refresh_approved) === 1 && a.refresh_every_s !== null) restartRefresh(ctx.db, jobs, i.id, Number(a.refresh_every_s), clock()); // restore resumes the approved schedule
      return { id: i.id, status };
    },
  }),
  [OP.artifactRemove]: op<ArtifactRemoveInput, unknown>({
    redact: sayArtifact,
    async run(i, ctx) {
      if (!artifactRow(ctx.db, i.id)) throw notFound();
      stopRefreshJob(ctx.db, (ctx as unknown as { jobs?: JobsApi }).jobs, i.id);
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
  // not due yet (a re-run after a crash or a manual job resume): wait instead of reading again (finding 10)
  const due = a.next_refresh_at === null ? now : Number(a.next_refresh_at);
  if (due > now + 1000) return { status: "again", afterMs: due - now };
  let next: { state: string; nextAt: number | null } | null = null;
  try {
    await refreshArtifact(ctx.db, ctx.callApp as never, id, {
      mode: "scheduled",
      slot: `s${Math.floor(now / (every * 1000))}`,
      attempt: Number(a.consecutive_failures),
      now: clock,
      signal: ctx.signal,
      write: (fn) => ctx.checkpoint({ at: now }, fn),
      after: (o, at) => {
        next = recordTick(ctx.db, id, ctx.job.id, o, at);
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "job_lease_lost" || ctx.signal.aborted) throw e; // the SDK resumes it
    // an unexpected throw is a FAILED tick for the page, not only an SDK attempt (finding 9)
    next = ctx.db.transaction(() => recordTick(ctx.db, id, ctx.job.id, { failed: true, paused: false, deferred: false }, clock()));
  }
  ctx.statusChanged();
  const n = next as { state: string; nextAt: number | null } | null;
  if (!n || n.state === "paused_error" || n.nextAt === null) return { status: "done" };
  return { status: "again", afterMs: Math.max(1000, n.nextAt - clock()) };
}

/** (Re)start or stop the refresh job of a page. Cancels the page's old job first; enqueued by the owner (O6). */
export function restartRefresh(db: Db, jobs: JobsApi, id: string, everySeconds: number | null, now: number): void {
  const a = artifactRow(db, id);
  if (!a) return;
  const old = a.refresh_job_id === null ? null : String(a.refresh_job_id);
  const cancelOld = () => {
    if (!old) return;
    const j = jobs.get(old);
    if (j && ["queued", "waiting", "running", "paused"].includes(j.status)) jobs.cancel(old);
  };
  if (everySeconds === null) {
    db.prepare("UPDATE la_artifact SET refresh_approved = 0, refresh_state = 'off', next_refresh_at = NULL, refresh_job_id = NULL WHERE id = ?").run(id);
    cancelOld();
    return;
  }
  // enqueue FIRST: if it throws, the old job still runs (it is fenced by refresh_job_id anyway; re-review finding 2)
  const job = jobs.enqueue(REFRESH_JOB, { id });
  cancelOld();
  db.prepare("UPDATE la_artifact SET refresh_every_s = ?, refresh_approved = 1, refresh_state = 'on', consecutive_failures = 0, next_refresh_at = ?, refresh_job_id = ? WHERE id = ?").run(
    everySeconds,
    now,
    job.id,
    id,
  );
}
/** Stop the job of a page that is archived or deleted (approval is kept for a restore). */
function stopRefreshJob(db: Db, jobs: JobsApi | undefined, id: string): void {
  const a = artifactRow(db, id);
  const old = a?.refresh_job_id ? String(a.refresh_job_id) : null;
  if (!old || !jobs) return;
  const j = jobs.get(old);
  if (j && ["queued", "waiting", "running", "paused"].includes(j.status)) jobs.cancel(old);
  db.prepare("UPDATE la_artifact SET refresh_job_id = NULL WHERE id = ?").run(id);
}

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  publicRoutes: { "/v": viewerRoute },
  // a restore replaces the database with an older one; every link is ended after it (viewer.ts). The hook runs before the store
  // opens; if it throws, the SDK rolls the restore back.
  backup: {
    async afterRestore() {
      recordRestore(process.env.TB_DATA_DIR);
    },
  },
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
    const starved = Number(db.prepare("SELECT COUNT(*) AS c FROM la_artifact WHERE status = 'active' AND refresh_approved = 1 AND consecutive_deferrals >= 5").get()?.c ?? 0);
    if (starved > 0) return { code: "refresh_rate_limited", reason: `${starved} live page(s) cannot refresh: the source app keeps asking Live Artifacts to slow down` };
    return null;
  },
  async onStart(ctx) {
    bindScopeDb(ctx.db);
    if (restoreUnhandled(ctx.db)) endLinksAfterRestore(ctx.db, clock()); // the data was restored from a backup and this boot has not handled it (S3-3)
    await ensureDocKey(ctx.secrets); // the document-ticket key: created once, kept sealed in the SDK's secret store
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
