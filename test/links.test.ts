// Link lifecycle (S4, DESIGN §3.1, §3.2, §4.7): create, caps, expiry, revoke, pin, publish, the hold guard. Handlers run
// against the migrated database with a fake context; the viewer path answers the requests. Each rule has a quiet case
// (it works) and a fire case (the exact code when it must not). The held flow on the real SDK is in links-e2e.test.ts.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { digest, opaqueDigest } from "@opt2-tealbrick/manifest";
import { type Db, type OpContext, VIEW_ORIGIN_MISSING } from "@opt2-tealbrick/miniapp-sdk";
import { bindScopeDb, definition, handlers, setClock } from "../src/app.ts";
import { LIMITS } from "../src/limits.ts";
import { publishHoldText, shareHoldText } from "../src/links.ts";
import { handleViewer, type ViewerConfig } from "../src/viewer.ts";
import { AGENT_A, AGENT_B, CRUD, ctxFor, grantHolding, type Instance, memorySecrets, migratedDb, OWNER } from "./helpers.ts";

type Out = Record<string, any>;
const VIEWS = "https://views-abc.up.railway.app";
const CFG: ViewerConfig = { viewOrigin: VIEWS, mainOrigin: "https://bridge-abc.up.railway.app", workspaceName: "Acme", docKey: "test-doc-key-0123456789abcdef" };
const DAY = 86_400_000;
let db: Db;
let instances: Instance[];
let now: number;

/** An agent context: manage access to its own gallery, a grant that holds public_link unless told otherwise, a viewer address. */
const agent = (held: string[] = ["public_link"], extra: Record<string, unknown> = {}) =>
  ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.manage }, instances, {}, { grant: grantHolding(...held), viewUrl: VIEWS, ...extra });
const owner = (extra: Record<string, unknown> = {}) => ctxFor(db, OWNER, {}, instances, {}, { viewUrl: VIEWS, ...extra });
const run = async (opId: keyof typeof handlers, input: unknown, ctx: OpContext): Promise<Out> => (await handlers[opId].run(input as never, ctx)) as Out;
const code = (c: string) => (e: { code?: string }) => e.code === c;
const tokenOf = (url: string): string => url.split("/").pop() ?? "";
const view = (token: string, path = "", headers: Record<string, string> = { "sec-fetch-dest": "document" }) =>
  handleViewer(db, new Request(`http://live-artifacts.views.internal/${token}${path}`, { headers }), CFG, now);

async function page(title = "Weekly operations"): Promise<string> {
  const out = await run("artifact_create", { title, view: { html: "<!doctype html><body>v1</body>" }, contract: { v: 1, inputs: [{ key: "n", kind: "push", label: "Numbers" }] } }, agent());
  return String(out.id);
}
/** The page as the agent saw it with artifact_get: the version the link shows (the pin, else the live one), its sha256, the title. */
function seen(id: string, pin?: number | null): { version: number; htmlSha256: string; title: string } {
  const a = db.prepare("SELECT title, live_version FROM la_artifact WHERE id = ?").get(id);
  const n = pin ?? Number(a?.live_version);
  return { version: n, htmlSha256: String(db.prepare("SELECT html_sha256 FROM la_version WHERE artifact_id = ? AND n = ?").get(id, n)?.html_sha256), title: String(a?.title) };
}
const sha = (id: string, n: number): string => String(db.prepare("SELECT html_sha256 FROM la_version WHERE artifact_id = ? AND n = ?").get(id, n)?.html_sha256);
const share = (id: string, extra: Record<string, unknown> = {}, ctx: OpContext = agent()) => run("artifact_share", { id, expect: seen(id, extra.pin as number | null | undefined), ...extra }, ctx);
/** artifact_publish with the sha256 of the version as `expect`; `extra.expect` adds the staged title/description to promote. */
const publish = (id: string, version: number, extra: Record<string, unknown> = {}, ctx: OpContext = agent()) =>
  run("artifact_publish", { id, version, ...extra, expect: { htmlSha256: sha(id, version), ...(extra.expect as object | undefined) } }, ctx);
const PAGE_CHANGED = (e: { code?: string; httpStatus?: number }) => e.code === "page_changed" && e.httpStatus === 409;

beforeEach(async () => {
  db = migratedDb();
  instances = [];
  now = Date.UTC(2026, 9, 17, 12, 0, 0);
  setClock(() => now);
  bindScopeDb(db);
  await definition.onStart?.({ db, secrets: memorySecrets(), scopes: { instances: ctxFor(db, OWNER, {}, instances).scopes.instances } } as never);
});

describe("artifact_share and link_create", () => {
  it("creates a link: the address has a tbv_ token, only its digest is stored, the answer names the expiry (quiet on good)", async () => {
    const id = await page();
    const out = await share(id, { label: " Novak Dental " });
    assert.match(out.url, new RegExp(`^${VIEWS}/v/live-artifacts/tbv_[A-Za-z0-9_-]{43}$`));
    assert.match(out.linkId, /^lnk_/);
    assert.equal(out.expiresAt, new Date(now + 7 * DAY).toISOString(), "no expiresInDays → the owner's default (7 days)");
    const row = db.prepare("SELECT * FROM la_link WHERE id = ?").get(out.linkId);
    assert.equal(row?.token_digest, opaqueDigest(tokenOf(out.url)));
    assert.match(tokenOf(out.url), /^tbv_[A-Za-z0-9_-]{43}$/);
    assert.ok(JSON.stringify(row).includes(opaqueDigest(tokenOf(out.url))), "the digest IS stored");
    assert.ok(!JSON.stringify(row).includes(tokenOf(out.url)), "the token itself is never stored");
    assert.deepEqual([row?.label, row?.kind, row?.created_by_type, row?.created_by_name, row?.pin_version], ["Novak Dental", "viewer", "agent", AGENT_A.name, null]);
    assert.equal(view(tokenOf(out.url)).status, 200);
  });

  it("the owner's default lifetime (Settings) is used; a given expiresInDays wins; the longest is 90 days", async () => {
    const id = await page();
    await run("settings_set", { defaultLinkDays: 30 }, owner());
    assert.equal((await share(id)).expiresAt, new Date(now + 30 * DAY).toISOString());
    assert.equal((await share(id, { expiresInDays: 1 })).expiresAt, new Date(now + DAY).toISOString());
    assert.equal((await share(id, { expiresInDays: 90 })).expiresAt, new Date(now + 90 * DAY).toISOString());
    await assert.rejects(share(id, { expiresInDays: 91 }), code("link_days_invalid"));
    await assert.rejects(share(id, { expiresInDays: 0 }), code("link_days_invalid"));
  });

  it("the owner creates a link with link_create: no hold, no grant needed (quiet on good)", async () => {
    const id = await page();
    const out = await run("link_create", { id, label: "Board", expiresInDays: 3 }, owner());
    assert.equal(out.expiresAt, new Date(now + 3 * DAY).toISOString());
    assert.equal(db.prepare("SELECT created_by_type, created_by_name FROM la_link WHERE id = ?").get(out.linkId)?.created_by_type, "person");
    assert.equal(view(tokenOf(out.url)).status, 200);
  });

  it("view_origin_missing (409) while the bridge has no viewer address; a viewer address that is not https is none either", async () => {
    const id = await page();
    for (const viewUrl of [undefined, null, "", "http://views.example", "https://views.example/path"]) {
      await assert.rejects(share(id, {}, agent(["public_link"], { viewUrl })), code(VIEW_ORIGIN_MISSING), String(viewUrl));
      await assert.rejects(run("link_create", { id }, owner({ viewUrl })), code(VIEW_ORIGIN_MISSING), String(viewUrl));
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link").get()?.c, 0, "nothing was created");
  });

  it("an archived or unknown page gets no link; the answer for an unreadable page is not_found", async () => {
    const id = await page();
    db.prepare("UPDATE la_artifact SET status = 'archived' WHERE id = ?").run(id);
    await assert.rejects(share(id), code("artifact_archived"));
    await assert.rejects(share("art_01J0000000000000000000ZZZZ"), code("not_found"));
    // the page lives in a gallery this agent cannot reach
    const other = await run("artifact_create", { title: "Clerk page", view: { html: "<p>x</p>" } }, ctxFor(db, AGENT_B, { [AGENT_B.id]: CRUD.manage }, instances, {}, { grant: grantHolding("public_link"), viewUrl: VIEWS }));
    await assert.rejects(share(String(other.id)), code("not_found"));
  });

  it("an agent needs create access to the gallery (read only is scope_denied)", async () => {
    const id = await page();
    const reader = ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.read }, instances, {}, { grant: grantHolding("public_link"), viewUrl: VIEWS });
    await assert.rejects(share(id, {}, reader), code("scope_denied"));
  });
});

describe("approve-then-swap: the approval is bound to the page content (expect)", () => {
  const noLink = () => assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link").get()?.c, 0, "no link was created");
  it("a new version after the agent looked: page_changed (409) and no link (the reviewer's repro)", async () => {
    const id = await page();
    const looked = seen(id); // what the owner was shown and approved
    await run("artifact_update", { id, view: { html: "<p>swapped after approval</p>" } }, agent()); // nobody shares yet: live moves at once
    await assert.rejects(run("artifact_share", { id, expect: looked }, agent()), PAGE_CHANGED);
    noLink();
    // asking again with what the agent sees now works
    assert.match((await share(id)).url, /^https:/);
  });
  it("a new title, a forged sha256 or another version: page_changed", async () => {
    const id = await page();
    const looked = seen(id);
    for (const bad of [{ ...looked, htmlSha256: "sha256:00" }, { ...looked, version: 2 }, { ...looked, title: "Another title" }]) {
      await assert.rejects(run("artifact_share", { id, expect: bad }, agent()), PAGE_CHANGED, JSON.stringify(bad));
    }
    await run("artifact_update", { id, title: "Renamed" }, agent());
    await assert.rejects(run("artifact_share", { id, expect: looked }, agent()), PAGE_CHANGED, "the title moved");
    noLink();
  });
  it("a pinned link: expect.version must be the pin; an old page that kept its version stays valid", async () => {
    const id = await page();
    await run("artifact_update", { id, view: { html: "<p>v2</p>" } }, agent());
    const pinned = seen(id, 1);
    assert.equal(pinned.version, 1);
    await assert.rejects(run("artifact_share", { id, pin: 1, expect: seen(id) }, agent()), PAGE_CHANGED, "the agent looked at version 2, the pin is 1");
    noLink();
    assert.ok((await run("artifact_share", { id, pin: 1, expect: pinned }, agent())).linkId, "version 1 is immutable: still what the owner saw");
  });
  it("a staged version does not change what a link shows: expect of the live version still matches (quiet on good)", async () => {
    const id = await page();
    await share(id);
    const looked = seen(id);
    await run("artifact_update", { id, view: { html: "<p>staged</p>" } }, agent());
    assert.ok((await run("artifact_share", { id, expect: looked }, agent())).linkId);
  });
  it("the owner's own link needs no expect (the owner sees the page in the app)", async () => {
    const id = await page();
    assert.ok((await run("link_create", { id }, owner())).linkId);
  });
});

describe("link_needs_hold (fail closed)", () => {
  it("artifact_share and artifact_publish refuse a grant that does not hold public_link: 403, nothing changes", async () => {
    const id = await page();
    for (const held of [[], ["destructive", "money", "first_contact"]]) {
      await assert.rejects(share(id, {}, agent(held)), (e: { code?: string; httpStatus?: number }) => e.code === "link_needs_hold" && e.httpStatus === 403);
      await assert.rejects(run("artifact_publish", { id, version: 1, data: [], expect: { htmlSha256: "x" } }, agent(held)), (e: { code?: string; httpStatus?: number }) => e.code === "link_needs_hold" && e.httpStatus === 403);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link").get()?.c, 0);
  });
  it("no verified grant (nothing to read) is a refusal too, never a pass", async () => {
    const id = await page();
    await assert.rejects(share(id, {}, agent(["public_link"], { grant: null })), code("link_needs_hold"));
    await assert.rejects(share(id, {}, agent(["public_link"], { grant: { claims: {} } })), code("link_needs_hold"));
    await assert.rejects(share(id, {}, agent(["public_link"], { grant: { claims: { held: "public_link" } } })), code("link_needs_hold"), "held must be a list");
  });
  it("a grant that holds public_link passes the guard (the SDK holds the call before the handler; the approved retry runs it)", async () => {
    const id = await page();
    assert.match((await share(id, {}, agent(["destructive", "public_link"]))).url, /^https:/);
  });
  it("the guard is checked before the viewer address and before the page (the answer reveals nothing)", async () => {
    await assert.rejects(share("art_01J0000000000000000000ZZZZ", {}, agent([], { viewUrl: null })), code("link_needs_hold"));
  });
  it("an app caller is held to the same rule", async () => {
    const id = await page();
    const app = ctxFor(db, { type: "app", id: "ins_01J0000000000000000000000X", name: "Open Design" }, { [AGENT_A.id]: CRUD.manage }, instances, {}, { grant: grantHolding(), viewUrl: VIEWS });
    await assert.rejects(share(id, {}, app), code("link_needs_hold"));
  });
  it("revoking is never held: a grant without public_link may revoke (agents may always narrow)", async () => {
    const id = await page();
    const out = await share(id);
    const r = await run("artifact_link_revoke", { linkId: out.linkId }, agent([]));
    assert.deepEqual(r, { revoked: true });
  });
  it("the owner's link_create ignores the family (person calls are not held)", async () => {
    const id = await page();
    assert.match((await run("link_create", { id }, owner())).linkId, /^lnk_/);
  });
});

describe("caps", () => {
  it("at most 5 active links per page (links_limit_artifact); revoked and ended links free a place", async () => {
    const id = await page();
    const made: Out[] = [];
    for (let k = 0; k < LIMITS.linksPerArtifact; k++) made.push(await share(id, { label: `l${k}` }));
    await assert.rejects(share(id), (e: { code?: string; httpStatus?: number }) => e.code === "links_limit_artifact" && e.httpStatus === 409);
    await run("link_revoke", { linkId: made[0]?.linkId }, owner());
    assert.ok((await share(id)).linkId, "a revoked link frees its place");
    now += 8 * DAY; // the other links end
    assert.ok((await share(id)).linkId, "ended links free their places");
  });
  it("at most 50 active links in the workspace (links_limit_workspace)", async () => {
    const pages: string[] = [];
    for (let k = 0; k < LIMITS.linksPerWorkspace / LIMITS.linksPerArtifact + 1; k++) pages.push(await page(`Page ${k}`));
    for (const id of pages.slice(0, 10)) for (let k = 0; k < LIMITS.linksPerArtifact; k++) await share(id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link").get()?.c, LIMITS.linksPerWorkspace);
    await assert.rejects(share(pages[10] as string), (e: { code?: string; httpStatus?: number }) => e.code === "links_limit_workspace" && e.httpStatus === 409);
    await assert.rejects(run("link_create", { id: pages[10] }, owner()), code("links_limit_workspace"), "the owner's link counts the same");
  });
  it("owner previews do not count against the caps", async () => {
    const id = await page();
    for (let k = 0; k < 3; k++) await run("artifact_preview_ticket", { id }, owner());
    for (let k = 0; k < LIMITS.linksPerArtifact; k++) await share(id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE kind = 'preview'").get()?.c, 3);
  });
});

describe("expiry and revoke", () => {
  it("a link works until the second it ends, and not at it (boundary)", async () => {
    const id = await page();
    const out = await share(id, { expiresInDays: 2 });
    const t = tokenOf(out.url);
    const ends = Date.parse(out.expiresAt);
    now = ends - 1;
    assert.equal(view(t).status, 200);
    assert.equal(view(t, "/data").status, 200);
    now = ends;
    assert.equal(view(t).status, 404, "ended");
    assert.equal(view(t, "/data").status, 404);
  });
  it("revoke is immediate: the next request answers 404, the same answer as an unknown link", async () => {
    const id = await page();
    const out = await share(id);
    const t = tokenOf(out.url);
    assert.equal(view(t).status, 200);
    assert.deepEqual(await run("link_revoke", { linkId: out.linkId }, owner()), { revoked: true });
    const gone = view(t);
    const unknown = view("tbv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(gone.status, 404);
    assert.deepEqual([gone.status, await gone.text(), gone.headers.get("content-type")], [unknown.status, await unknown.text(), unknown.headers.get("content-type")]);
    // a document ticket minted before the revoke dies with it
    assert.equal(view(t, "/data").status, 404);
  });
  it("revoking twice is fine; an unknown link is link_not_found; a preview is not a link", async () => {
    const id = await page();
    const out = await share(id);
    await run("link_revoke", { linkId: out.linkId }, owner());
    const first = Number(db.prepare("SELECT revoked_at FROM la_link WHERE id = ?").get(out.linkId)?.revoked_at);
    now += 1000;
    assert.deepEqual(await run("link_revoke", { linkId: out.linkId }, owner()), { revoked: true });
    assert.equal(Number(db.prepare("SELECT revoked_at FROM la_link WHERE id = ?").get(out.linkId)?.revoked_at), first, "the first revoke time stays");
    await assert.rejects(run("link_revoke", { linkId: "lnk_01J00000000000000000000000" }, owner()), code("link_not_found"));
    const t = await run("artifact_preview_ticket", { id }, owner());
    const previewId = String(db.prepare("SELECT id FROM la_link WHERE kind = 'preview'").get()?.id);
    assert.ok(t.url);
    await assert.rejects(run("link_revoke", { linkId: previewId }, owner()), code("link_not_found"));
  });
  it("agents can revoke a link in a gallery they may update (even one the owner made); not in one they only read", async () => {
    const id = await page();
    const ownersLink = await run("link_create", { id }, owner());
    assert.deepEqual(await run("artifact_link_revoke", { linkId: ownersLink.linkId }, agent([])), { revoked: true });
    assert.equal(view(tokenOf(ownersLink.url)).status, 404);
    const again = await run("link_create", { id }, owner());
    const reader = ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.read }, instances, {}, { grant: grantHolding() });
    await assert.rejects(run("artifact_link_revoke", { linkId: again.linkId }, reader), code("scope_denied"));
    assert.equal(view(tokenOf(again.url)).status, 200, "still open");
    // the SDK resolves the gallery of the link before the handler: unknown links map to a gallery nobody holds
    assert.equal(handlers.artifact_link_revoke.scope?.({ linkId: "lnk_01J00000000000000000000000" } as never, AGENT_A as never), "#missing");
    assert.equal(handlers.artifact_link_revoke.scope?.({ linkId: again.linkId } as never, AGENT_A as never), AGENT_A.id);
  });
  it("deleting a page ends its links; ended links go after 90 days with their view counts", async () => {
    const id = await page();
    const out = await share(id);
    view(out.url.split("/").pop(), "", { "sec-fetch-dest": "document" });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_view_day").get()?.c, 1);
    now += 8 * DAY; // ended
    await share(id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE id = ?").get(out.linkId)?.c, 1, "kept for a while (the Links page shows it as ended)");
    now += LIMITS.endedLinkKeepDays * DAY;
    await share(id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link WHERE id = ?").get(out.linkId)?.c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_view_day").get()?.c, 0);
  });
});

describe("pin", () => {
  it("a pinned link keeps showing its version while the live one moves; an unpinned link follows", async () => {
    const id = await page();
    const pinned = await share(id, { pin: 1 });
    const follow = await share(id);
    await run("artifact_update", { id, view: { html: "<p>v2</p>" } }, agent());
    await run("publish_version", { id, version: 2 }, owner());
    const docOf = async (url: string) => {
      const data = (await view(tokenOf(url), "/data").json()) as Out;
      assert.ok(data.doc.includes(`.${data.live}.`));
      return data.live;
    };
    assert.equal(await docOf(pinned.url), 1);
    assert.equal(await docOf(follow.url), 2);
  });
  it("pin null is the same as no pin; an unknown version is version_unknown (404) and creates nothing", async () => {
    const id = await page();
    const out = await share(id, { pin: null });
    assert.equal(db.prepare("SELECT pin_version FROM la_link WHERE id = ?").get(out.linkId)?.pin_version, null);
    await assert.rejects(share(id, { pin: 9 }), (e: { code?: string; httpStatus?: number }) => e.code === "version_unknown" && e.httpStatus === 404);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM la_link").get()?.c, 1);
  });
  it("version pruning keeps a pinned version while its link is active, and releases it when the link ends", async () => {
    const id = await page();
    const pinned = await share(id, { pin: 1 });
    for (let k = 0; k < LIMITS.versionsKept + 3; k++) {
      await run("artifact_update", { id, view: { html: `<p>edit ${k}</p>` } }, agent());
      await run("publish_version", { id, version: Number(db.prepare("SELECT MAX(n) AS n FROM la_version WHERE artifact_id = ?").get(id)?.n) }, owner());
    }
    assert.ok(db.prepare("SELECT 1 FROM la_version WHERE artifact_id = ? AND n = 1").get(id), "pinned version 1 survived");
    await run("link_revoke", { linkId: pinned.linkId }, owner());
    await run("artifact_update", { id, view: { html: "<p>after</p>" } }, agent());
    assert.equal(db.prepare("SELECT 1 FROM la_version WHERE artifact_id = ? AND n = 1").get(id), undefined, "released once the link is gone");
  });
});

describe("staging and artifact_publish (DESIGN §4.7)", () => {
  async function stagedPage() {
    const id = await page();
    await share(id);
    await run("artifact_update", { id, view: { html: "<p>v2</p>" } }, agent());
    await run("artifact_update", { id, view: { html: "<p>v3</p>" } }, agent());
    return id;
  }
  const state = (id: string) => db.prepare("SELECT live_version, staged_version FROM la_artifact WHERE id = ?").get(id);
  it("a shared page stages new versions and new data; nothing reaches viewers until it is published", async () => {
    const id = await stagedPage();
    assert.deepEqual([Number(state(id)?.live_version), Number(state(id)?.staged_version)], [1, 3]);
    const put = await run("artifact_data_put", { id, key: "n", data: { total: 1 } }, agent());
    assert.equal(put.staged, true);
  });
  it("promotes exactly the staged version; the answer lists the data it published", async () => {
    const id = await stagedPage();
    const put = await run("artifact_data_put", { id, key: "n", data: { total: 7 } }, agent());
    const r = await publish(id, 3, { data: [{ key: "n", digest: put.digest }] });
    assert.deepEqual(r, { liveVersion: 3, publishedKeys: ["n"] });
    assert.deepEqual([Number(state(id)?.live_version), state(id)?.staged_version], [3, null]);
    assert.equal(db.prepare("SELECT data_json FROM la_snapshot WHERE artifact_id = ? AND key = 'n'").get(id)?.data_json, JSON.stringify({ total: 7 }));
  });
  it("another version is a rollback and leaves the staged one waiting; version 3 only goes live when asked", async () => {
    const id = await stagedPage();
    const r = await publish(id, 2);
    assert.deepEqual(r, { liveVersion: 2, publishedKeys: [] });
    assert.deepEqual([Number(state(id)?.live_version), Number(state(id)?.staged_version)], [2, 3], "the staged version still waits");
  });
  it("staged data that you did not list stays staged; listed data must match its digest (staged_changed, nothing changes)", async () => {
    const id = await stagedPage();
    const put = await run("artifact_data_put", { id, key: "n", data: { total: 1 } }, agent());
    await run("artifact_data_put", { id, key: "n", data: { total: 2 } }, agent()); // the agent changed its mind after asking
    await assert.rejects(publish(id, 3, { data: [{ key: "n", digest: put.digest }] }), (e: { code?: string; httpStatus?: number }) => e.code === "staged_changed" && e.httpStatus === 409);
    assert.deepEqual([Number(state(id)?.live_version), Number(state(id)?.staged_version)], [1, 3], "the version did not move either");
    const none = await publish(id, 3);
    assert.deepEqual(none.publishedKeys, [], "no data listed → none published");
    assert.ok(db.prepare("SELECT staged_json FROM la_snapshot WHERE artifact_id = ? AND key = 'n'").get(id)?.staged_json, "still staged");
    await assert.rejects(publish(id, 3, { data: [{ key: "n", digest: digest({ nope: true }) }] }), code("staged_changed"));
  });
  it("nothing to publish (the live version, no data) and an unknown version are refused", async () => {
    const id = await page();
    await assert.rejects(publish(id, 1), (e: { code?: string; httpStatus?: number }) => e.code === "nothing_to_publish" && e.httpStatus === 409);
    await assert.rejects(run("artifact_publish", { id, version: 5, expect: { htmlSha256: "x" } }, agent()), code("version_unknown"));
  });
  it("an agent needs update access to the gallery", async () => {
    const id = await stagedPage();
    const reader = ctxFor(db, AGENT_A, { [AGENT_A.id]: CRUD.read }, instances, {}, { grant: grantHolding("public_link") });
    await assert.rejects(publish(id, 3, {}, reader), code("scope_denied"));
    assert.equal(Number(state(id)?.live_version), 1);
  });
  it("the agent path never promotes a staged title or description that is not listed in expect; the owner's publish still does", async () => {
    const id = await page();
    await share(id);
    await run("artifact_update", { id, title: "New title", description: "New words", view: { html: "<p>v2</p>" } }, agent());
    const row = () => db.prepare("SELECT title, description, staged_title, staged_description FROM la_artifact WHERE id = ?").get(id);
    assert.deepEqual([row()?.title, row()?.staged_title], ["Weekly operations", "New title"]);
    await publish(id, 2); // version only
    assert.deepEqual([row()?.title, row()?.description, row()?.staged_title, row()?.staged_description], ["Weekly operations", "", "New title", "New words"], "both stay staged for the owner");
    assert.equal(Number(db.prepare("SELECT live_version FROM la_artifact WHERE id = ?").get(id)?.live_version), 2);
    // now list the title only: the title moves, the description stays staged
    await publish(id, 2, { expect: { title: "New title" } });
    assert.deepEqual([row()?.title, row()?.description, row()?.staged_title, row()?.staged_description], ["New title", "", null, "New words"]);
    // the owner's publish takes the rest
    await run("publish_version", { id, version: 2 }, owner());
    assert.deepEqual([row()?.description, row()?.staged_description], ["New words", null]);
  });
  it("a listed title or description that is not the staged one, or that belongs to another version, is page_changed and nothing changes", async () => {
    const id = await stagedPage();
    await run("artifact_update", { id, title: "Later title" }, agent()); // staged title (a title-only change; the staged version stays 3)
    await assert.rejects(publish(id, 3, { expect: { title: "Another" } }), PAGE_CHANGED);
    await assert.rejects(publish(id, 3, { expect: { description: "none staged" } }), PAGE_CHANGED);
    await assert.rejects(publish(id, 3, { expect: { htmlSha256: "sha256:00" } }), PAGE_CHANGED, "the version is not the one the agent saw");
    await assert.rejects(publish(id, 2, { expect: { title: "Later title" } }), PAGE_CHANGED, "a rollback does not carry the staged title");
    assert.deepEqual([Number(state(id)?.live_version), Number(state(id)?.staged_version)], [1, 3], "nothing moved");
    assert.equal(db.prepare("SELECT staged_title FROM la_artifact WHERE id = ?").get(id)?.staged_title, "Later title");
  });
  it("a staged title alone (no new version) is published with the live version in expect", async () => {
    const id = await page();
    await share(id);
    await run("artifact_update", { id, title: "Only the title" }, agent());
    await assert.rejects(publish(id, 1), (e: { code?: string }) => e.code === "nothing_to_publish");
    await publish(id, 1, { expect: { title: "Only the title" } });
    assert.equal(db.prepare("SELECT title FROM la_artifact WHERE id = ?").get(id)?.title, "Only the title");
  });
  it("the owner's publish_version still promotes everything staged (no hold)", async () => {
    const id = await stagedPage();
    await run("artifact_data_put", { id, key: "n", data: { total: 1 } }, agent());
    assert.deepEqual(await run("publish_version", { id, version: 3 }, owner()), { liveVersion: 3, publishedKeys: ["n"] });
  });
});

describe("hold texts (DESIGN T4)", () => {
  async function richPage(title = "Weekly operations"): Promise<string> {
    const id = await run(
      "artifact_create",
      {
        title,
        view: { html: "<p>x</p>" },
        contract: {
          v: 1,
          inputs: [
            { key: "n", kind: "push", label: "Numbers" },
            { key: "t", kind: "read", label: "Open issues", product: "kanban", op: "issues_list" },
            { key: "k", kind: "read", label: "Client notes", product: "knowledge", op: "recall" },
          ],
        },
      },
      agent(),
    ).then((o) => String(o.id));
    db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 1 WHERE artifact_id = ? AND key IN ('t', 'n')").run(id);
    db.prepare("UPDATE la_source SET approved_digest = digest, viewers = 0 WHERE artifact_id = ? AND key = 'k'").run(id);
    return id;
  }
  it("artifact_share names the page, author, size and digest, the lifetime, the version and which sources link viewers see", async () => {
    const id = await richPage();
    const text = shareHoldText(db, { id, label: "Novak", expiresInDays: 14, pin: 1, expect: seen(id, 1) }, now);
    assert.match(text, /live page "Weekly operations", made by "Scout"\./);
    assert.match(text, /14 days after you approve \(label: "Novak"\)/);
    assert.match(text, /Version 1: 1 KiB, sha256 [0-9a-f]{16}…, written by "Scout"\./);
    assert.match(text, /The agent saw exactly this page\. If the page changes before the call runs, the call is refused \(page_changed\)\./);
    assert.match(text, /to people with the link: Numbers \(data pushed by an agent\); Open issues \(kanban issues_list\)\./);
    assert.match(text, /does not show: Client notes \(knowledge recall\)\./);
    assert.match(text, /without network access/);
    assert.ok(text.length < 16_000);
    const follow = shareHoldText(db, { id }, now);
    assert.match(follow, /7 days after you approve/);
    assert.match(follow, /follows the live version of the page \(now version 1\)/);
    assert.doesNotMatch(follow, /WITHOUT your approval/, "autoPublish is owner: nothing to warn about");
    // the receipt text names the page, never an address
    assert.equal(handlers.artifact_share.redact?.({ id } as never) ?? "", 'share page "Weekly operations" with a link');
  });
  it("a pin says the page code stays while title and data follow; a staged or an older pinned version is flagged with its size and digest", async () => {
    const id = await richPage();
    await share(id); // an active link: the next versions are staged
    await run("artifact_update", { id, view: { html: "<p>v2 staged</p>" } }, agent());
    const staged = shareHoldText(db, { id, pin: 2 }, now);
    assert.match(staged, /shows the page code of version 2 only: the page code stays at version 2; title and data still follow updates you approve\./);
    assert.match(staged, /Version 2: 1 KiB, sha256 [0-9a-f]{16}…, written by "Scout"\./);
    assert.match(staged, /Version 2 has not been reviewed yet: it is staged and waits for you\. It is not live\./);
    await run("publish_version", { id, version: 2 }, owner());
    const older = shareHoldText(db, { id, pin: 1 }, now);
    assert.match(older, /Version 1 is older than the live version \(now version 2\)\./);
    assert.match(older, /Version 1: 1 KiB, sha256 [0-9a-f]{16}…/);
    assert.doesNotMatch(shareHoldText(db, { id, pin: 2 }, now), /not been reviewed|older than/, "the live version needs no flag");
    db.prepare("UPDATE la_artifact SET live_version = 1 WHERE id = ?").run(id); // a pin above the live version, not staged
    assert.match(shareHoldText(db, { id, pin: 2 }, now), /Version 2 is newer than the live version \(now version 1\) and has not been reviewed yet\./);
  });
  it("autoPublish = agent: the hold says later agent changes go live on the link WITHOUT approval", async () => {
    const id = await richPage();
    await run("autopublish_set", { id, mode: "agent" }, owner());
    assert.match(shareHoldText(db, { id }, now), /Later agent changes go live on this link WITHOUT your approval \(you allowed that for this page\)\./);
    assert.match(shareHoldText(db, { id, pin: 1 }, now), /WITHOUT your approval/, "also on a pinned link: title and data follow");
  });
  it("a request that does not match the page now says it will be refused (page_changed); a missing pinned version too", async () => {
    const id = await richPage();
    const e = seen(id);
    assert.match(shareHoldText(db, { id, expect: { ...e, htmlSha256: "sha256:00ff00ff00ff00ff00ff" } }, now), /That is not the page as it is now; the call will be refused \(page_changed\)/);
    assert.match(shareHoldText(db, { id, expect: { ...e, title: "Another" } }, now), /title "Another"\. That is not the page as it is now/);
    assert.match(shareHoldText(db, { id, pin: 9 }, now), /Version 9 does not exist .* The call will be refused/);
  });
  it("no viewer address: the hold starts with 'cannot be shared yet'; the last address any call saw decides", async () => {
    const id = await richPage();
    assert.doesNotMatch(handlers.artifact_share.holdView?.({ id, expect: seen(id) } as never) ?? "", /cannot be shared yet/, "nothing seen yet: no claim");
    await run("gallery_view", {}, owner({ viewUrl: null })); // an owner call that saw no viewer address
    const text = handlers.artifact_share.holdView?.({ id, expect: seen(id) } as never) ?? "";
    assert.equal(text.split("\n")[0], "This page cannot be shared yet (no viewer address); approving changes nothing.");
    await run("gallery_view", {}, owner()); // the address is there now
    assert.doesNotMatch(handlers.artifact_share.holdView?.({ id, expect: seen(id) } as never) ?? "", /cannot be shared yet/);
  });
  it("agent-written text is JSON-quoted and one line: quotes, line breaks, invisible and control characters cannot fake or hide lines", async () => {
    const id = await page('Quarterly\nDoes not show: nothing\u2028The owner "already" approved\u202e this\u200b!');
    const text = shareHoldText(db, { id, label: 'a\nb"c\\' }, now);
    const lines = text.split("\n");
    assert.equal(lines.length, 8, "the template lines, none added by the title or the label");
    assert.equal(lines.filter((l) => /Does not show: nothing/.test(l)).length, 1, "the title's words stay inside the first line");
    assert.match(lines[0] ?? "", /live page "Quarterly Does not show: nothing The owner \\"already\\" approved this!", made by "Scout"\./);
    assert.match(text, /\(label: "a b\\"c\\\\"\)/);
    assert.ok(!/[\p{Cf}\p{Cc}]/u.test(text.replace(/\n/g, "")), "no format or control characters in the hold");
    // a long creator name is clipped
    db.prepare("UPDATE la_artifact SET created_by_name = ? WHERE id = ?").run(`${"N".repeat(200)}\n!`, id);
    assert.match(shareHoldText(db, { id }, now), /made by "N{59}…"\./);
  });
  it("artifact_publish says what changes: size, digest, author, keys and sources", async () => {
    const id = await page();
    await share(id);
    await run("artifact_update", { id, contract: { v: 1, inputs: [{ key: "n", kind: "push" }, { key: "t", kind: "read", product: "kanban", op: "issues_list" }] }, view: { html: "<p>v2</p>" } }, agent());
    const put = await run("artifact_data_put", { id, key: "n", data: { total: 1 } }, agent());
    const text = publishHoldText(db, { id, version: 2, data: [{ key: "n", digest: put.digest }], expect: { htmlSha256: sha(id, 2) } }, now);
    assert.match(text, /Version 2 waits for you and becomes live now \(version 1 is live\)\./);
    assert.match(text, /Version 2: 1 KiB, sha256 [0-9a-f]{16}…, written by "Scout"\./);
    assert.match(text, /Data sources: adds t\./);
    assert.match(text, /Pushed data "n" goes live: 1 KiB, digest [0-9a-f]{16}…\./);
    assert.match(publishHoldText(db, { id, version: 9 }, now), /Version 9 does not exist .* will be refused/);
    assert.match(publishHoldText(db, { id, version: 2, data: [{ key: "n", digest: "sha256:0" }] }, now), /staged data changed after it was asked for; the call will be refused/);
    assert.match(publishHoldText(db, { id, version: 2, expect: { htmlSha256: "sha256:ffff" } }, now), /That is not version 2 as it is now; the call will be refused \(page_changed\)/);
  });
  it("the rollback text says it is a rollback, keeps the staged version staged, and does not promise the staged title", async () => {
    const id = await page();
    await share(id);
    await run("artifact_update", { id, view: { html: "<p>v2</p>" } }, agent());
    await run("publish_version", { id, version: 2 }, owner());
    await run("artifact_update", { id, title: "New title", view: { html: "<p>v3</p>" } }, agent()); // staged: version 3 and a title
    const text = publishHoldText(db, { id, version: 1, expect: { htmlSha256: sha(id, 1) } }, now);
    assert.match(text, /This rolls the page back from version 2 to the older version 1\./);
    assert.match(text, /The staged version 3 stays staged and waits for you\./);
    assert.match(text, /The staged title "New title" stays staged and waits for you\./);
    assert.doesNotMatch(text, /goes live with it/);
    // a request that lists the title of another version is refused, and the hold says so
    assert.match(publishHoldText(db, { id, version: 1, expect: { htmlSha256: sha(id, 1), title: "New title" } }, now), /belongs to version 3; the call will be refused \(page_changed\)/);
  });
});

describe("what the owner and the agents see", () => {
  it("links_list: every link of every page with its status and who made it, never an address", async () => {
    const a = await page("One");
    const b = await page("Two");
    const l1 = await share(a, { label: "A1", expiresInDays: 1 });
    const l2 = await run("link_create", { id: b, label: "B1" }, owner());
    const l3 = await share(b, { label: "B2" });
    await run("link_revoke", { linkId: l3.linkId }, owner());
    now += 2 * DAY;
    const list = await run("links_list", {}, owner());
    assert.deepEqual(
      list.items.map((i: Out) => [i.label, i.artifactTitle, i.createdBy.type, i.status]).sort(),
      [
        ["A1", "One", "agent", "expired"],
        ["B1", "Two", "person", "active"],
        ["B2", "Two", "agent", "revoked"],
      ],
    );
    assert.equal(list.active, 1);
    assert.match(l1.url, /tbv_/, "the answers of the create calls do hold an address");
    assert.ok(!JSON.stringify(list).includes("tbv_"), "no addresses");
    assert.ok([l1, l2, l3].every((l) => list.items.some((i: Out) => i.id === l.linkId)));
  });
  it("artifact_get and artifact_detail list links with counts and status, never tokens", async () => {
    const id = await page();
    const out = await share(id, { label: "Novak" });
    const got = await run("artifact_get", { id, include: ["links"] }, agent());
    assert.equal(got.links[0].label, "Novak");
    assert.equal(got.links[0].status, "active");
    assert.equal(got.artifact.links, 1);
    const token = tokenOf(out.url);
    assert.match(token, /^tbv_[A-Za-z0-9_-]{43}$/, "the token exists, so the absence checks below can fail");
    assert.ok(out.url.includes(token), "the address of the answer has it");
    assert.ok(!JSON.stringify(got).includes(token));
    assert.ok(!JSON.stringify(await run("artifact_detail", { id }, owner())).includes(token));
  });
  it("gallery_view tells the owner when the viewer address is missing (and stays quiet when it is there)", async () => {
    const quiet = await run("gallery_view", {}, owner());
    assert.ok(!quiet.notices.some((n: Out) => n.code === "view_origin_missing"));
    const missing = await run("gallery_view", {}, owner({ viewUrl: null }));
    assert.ok(missing.notices.some((n: Out) => n.code === "view_origin_missing"));
  });
  it("receipt texts never hold an address", async () => {
    const id = await page();
    for (const op of ["artifact_share", "artifact_publish", "artifact_link_revoke", "link_create", "link_revoke"] as const) {
      const text = handlers[op].redact?.({ id, linkId: "lnk_01J00000000000000000000000", version: 2, data: [{ key: "n", digest: "x" }] } as never, { url: `${VIEWS}/v/live-artifacts/tbv_x` } as never) ?? "";
      assert.ok(text.length > 0 && text.length <= 280 && !text.includes("tbv_") && !text.includes("http"), `${op}: ${text}`);
    }
  });
});
