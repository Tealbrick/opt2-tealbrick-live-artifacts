// The owner UI (src/ui/gallery.tsx, page.tsx, settings.tsx, App.tsx) against the real SDK client and a stub server.
// The UI is compiled with the build tsconfig into dist/ui-test-live (JSX needs a compile) and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-live");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/live-artifacts/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "File"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
for (const k of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[k] = (win as unknown as Record<string, (...a: unknown[]) => unknown>)[k]?.bind(win);
g.IS_REACT_ACT_ENVIRONMENT = true;
// src/ui/index.html has <base href="/a/live-artifacts/">; the router reads paths relative to it
const base = win.document.createElement("base");
base.setAttribute("href", "/a/live-artifacts/");
win.document.head.appendChild(base);

// ── stub server (the app's person ops under /a/live-artifacts/tb/v1/) ──────
const actor = (name: string) => ({ type: "agent" as const, id: `agt_${name}`, name });
const refresh = (state: string, every: number | null, lastAt: string | null = null) => ({ everySeconds: every, lastAt, nextAt: null, state });
const summary = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  description: `About ${title}`,
  gallery: "shared",
  status: "active",
  liveVersion: 7,
  stagedVersion: null,
  links: 0,
  sourcesPending: 0,
  refresh: refresh("off", null),
  updatedAt: "2026-10-14T08:00:00.000Z",
  createdBy: actor("Scout"),
  ...extra,
});
const WEEKLY = summary("art_weekly", "Weekly operations", { links: 2, stagedVersion: 8, refresh: refresh("on", 900, new Date(Date.now() - 4 * 60_000).toISOString()) });
const ONBOARD = summary("art_onboard", "Client onboarding status", { sourcesPending: 2, refresh: refresh("waiting_approval", 3600), createdBy: actor("Front desk") });
const HIRING = summary("art_hiring", "Hiring pipeline", { refresh: refresh("paused_error", 900, "2026-10-13T21:55:00.000Z") });
const COUNTS = { all: 3, review: 1, shared: 1, stale: 1, archived: 0 };

const SRC_OK = {
  key: "issues",
  kind: "read",
  label: "Open issues",
  product: "kanban",
  op: "issues_list",
  input: { project: "Website" },
  projection: { pick: ["id", "title", "status", "owner"], limit: 200 },
  digest: "sha256:aaaa",
  approved: true,
  viewers: true,
  status: "ok",
  fetchedAt: "2026-10-14T08:00:00.000Z",
  staged: false,
  code: null,
};
const SRC_NEW = { ...SRC_OK, key: "notes", label: "Client notes", product: "knowledge", op: "documents_search", input: { tag: "client" }, projection: { pick: ["title", "date"], limit: 50 }, digest: "sha256:bbbb", approved: false, viewers: false, status: "not_approved", fetchedAt: null };
const version = (n: number, extra: Record<string, unknown> = {}) => ({ n, sha256: `sha${n}`, bytes: 2048, createdBy: actor("Scout"), createdAt: "2026-10-13T09:12:00.000Z", note: "", live: false, staged: false, ...extra });
const DETAIL = {
  artifact: { ...WEEKLY, autoPublish: "owner", origin: { kind: "agent", ref: null }, forkedFrom: null },
  version: { ...version(7), html: "<p>hi</p>", contract: {} },
  versions: [version(8, { staged: true, note: "adds a blocked column" }), version(7, { live: true }), version(6)],
  sources: [SRC_OK, SRC_NEW],
  links: [{ id: "lnk_1", label: "Novak Dental", createdBy: actor("Scout"), createdAt: "2026-10-10T08:00:00.000Z", expiresAt: "2026-10-21T08:00:00.000Z", revokedAt: null, pinVersion: null, views: 14, lastSeenDay: "2026-10-13", status: "active" }],
  activity: [],
  lint: [],
};

interface Stub {
  calls: { op: string; input: Record<string, unknown> }[];
  fail: Record<string, { status: number; code: string; message?: string } | undefined>;
  gate: Record<string, Promise<void> | undefined>;
  out: Record<string, unknown>;
  items: unknown[];
}
const stub: Stub = { calls: [], fail: {}, gate: {}, out: {}, items: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/live-artifacts/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input ?? {} });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: failure.message ?? `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  const given = stub.out[op];
  if (given !== undefined) return json(200, { status: "ok", output: given });
  switch (op) {
    case "gallery_view": {
      const filter = (body.input as { filter?: string }).filter ?? "all";
      const items = filter === "all" ? stub.items : stub.items.filter((i) => (filter === "review" ? (i as { sourcesPending: number }).sourcesPending > 0 : false));
      return json(200, { status: "ok", output: { galleries: [], items, nextCursor: null, counts: COUNTS, notices: [], settings: { defaultLinkDays: 7 } } });
    }
    case "artifact_detail":
      return json(200, { status: "ok", output: DETAIL });
    case "tb.holds_list":
      return json(200, { status: "ok", output: { items: [], nextCursor: null } });
    default:
      return json(200, { status: "ok", output: {} });
  }
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "live-artifacts" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const field = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button, a")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `control "${text}"`);
  return found as HTMLButtonElement;
};
/** The dialog that is open (closed dialogs stay in the page, empty). */
const openDialog = (host: Element) => {
  const found = [...host.querySelectorAll("dialog")].find((d) => d.childElementCount > 0);
  assert.ok(found, "an open dialog");
  return found as HTMLDialogElement;
};
const within = (host: Element, label: string) => {
  const found = host.querySelector(`[aria-label="${label}"]`);
  assert.ok(found, `region "${label}"`);
  return found;
};
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);
const reset = () => {
  stub.calls = [];
  stub.fail = {};
  stub.gate = {};
  stub.out = {};
  stub.items = [WEEKLY, ONBOARD, HIRING];
  // the normal state today: the bridge has no viewer address yet (LA-1)
  stub.fail.artifact_preview_ticket = { status: 409, code: "view_origin_missing" };
};

type Gallery = typeof import("../src/ui/gallery.tsx");
type Page = typeof import("../src/ui/page.tsx");
type Settings = typeof import("../src/ui/settings.tsx");
type Links = typeof import("../src/ui/links.tsx");
type AppModule = typeof import("../src/ui/App.tsx");
let gallery: Gallery;
let page: Page;
let settings: Settings;
let links: Links;
let app: AppModule;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const at = (f: string) => pathToFileURL(join(outDir, "ui", f)).href;
  gallery = (await import(at("gallery.js"))) as Gallery;
  page = (await import(at("page.js"))) as Page;
  settings = (await import(at("settings.js"))) as Settings;
  links = (await import(at("links.js"))) as Links;
  app = (await import(at("App.js"))) as AppModule;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const mountPage = (onGone = () => {}) => mount(h(page.ArtifactPage, { id: "art_weekly", onGone }));

describe("Gallery", () => {
  it("renders the cards with tags and meta, and the filter chips with the server's counts", async () => {
    reset();
    const m = await mount(h(gallery.Gallery, { onOpen: () => {} }));
    assert.equal(m.host.querySelector("h1")?.textContent, "Gallery");
    assert.deepEqual(
      [...m.host.querySelectorAll(".tb-chip")].map((c) => c.textContent),
      ["All 3", "Needs your review 1", "Shared 1", "Not refreshing 1", "Archived 0"],
    );
    assert.equal(m.host.querySelector('.tb-chip[aria-pressed="true"]')?.textContent, "All 3");
    assert.deepEqual(callsOf("gallery_view")[0]?.input, { filter: "all" });
    const cards = [...m.host.querySelectorAll("article.tb-card")];
    assert.deepEqual(cards.map((c) => c.querySelector("h3")?.textContent), ["Weekly operations", "Client onboarding status", "Hiring pipeline"]);
    const [weekly, onboard, hiring] = cards as Element[];
    const tags = (c: Element | undefined) => [...(c?.querySelectorAll(".tb-tag") ?? [])].map((t) => t.textContent);
    assert.deepEqual(tags(weekly), ["Live", "Shared · 2 links", "New version waits for you"]);
    assert.deepEqual(tags(onboard), ["Live", "Needs your review"]);
    assert.deepEqual(tags(hiring), ["Live", "Refresh paused"]);
    assert.match(weekly?.querySelector(".meta")?.textContent ?? "", /^Updated 4 min ago · every 15 min · made by Scout$/);
    assert.match(onboard?.querySelector(".meta")?.textContent ?? "", /Made by Front desk · 2 data sources wait for you · not refreshing yet/);
    assert.equal(field(weekly as Element, "Open").tagName, "A");
    assert.equal(field(onboard as Element, "Review").tagName, "A");
    await m.unmount();
  });

  it("switching a chip asks gallery_view for that filter", async () => {
    reset();
    const m = await mount(h(gallery.Gallery, { onOpen: () => {} }));
    await click(field(m.host, "Needs your review 1"));
    await flush();
    assert.deepEqual(callsOf("gallery_view").at(-1)?.input, { filter: "review" });
    assert.equal(m.host.querySelector('.tb-chip[aria-pressed="true"]')?.textContent, "Needs your review 1");
    assert.deepEqual([...m.host.querySelectorAll("article.tb-card h3")].map((x) => x.textContent), ["Client onboarding status"]);
    await click(field(m.host, "Archived 0"));
    await flush();
    assert.deepEqual(callsOf("gallery_view").at(-1)?.input, { filter: "archived" });
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /No pages match this filter/);
    await m.unmount();
  });

  it("Open goes to the page; Resume refresh approves the same schedule again", async () => {
    reset();
    const opened: string[] = [];
    const m = await mount(h(gallery.Gallery, { onOpen: (id: string) => opened.push(id) }));
    await click(field(m.host, "Open"));
    assert.deepEqual(opened, ["art_weekly"]);
    await click(field(m.host, "Resume refresh"));
    await flush();
    assert.deepEqual(callsOf("trigger_approve").map((c) => c.input), [{ id: "art_hiring", everySeconds: 900 }]);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("an empty gallery says what to do; a failed load is an error with Try again, not an empty list", async () => {
    reset();
    stub.items = [];
    const m = await mount(h(gallery.Gallery, { onOpen: () => {} }));
    assert.match(m.host.querySelector(".tb-empty")?.textContent ?? "", /Agents create pages here\./);
    await m.unmount();
    reset();
    stub.fail.gallery_view = { status: 500, code: "internal" };
    const bad = await mount(h(gallery.Gallery, { onOpen: () => {} }));
    assert.match(alerts(bad.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(bad.host)[0] ?? "", /raw upstream/);
    assert.equal(bad.host.querySelector(".tb-empty"), null);
    await bad.unmount();
  });

  it("Add a page by hand sends the title and the file and shows the lint advice", async () => {
    reset();
    stub.out.artifact_new = { id: "art_new", gallery: "shared", version: 1, lint: [{ level: "advice", code: "external_url", message: "The page links a file outside the document; it will not load." }] };
    const m = await mount(h(gallery.Gallery, { onOpen: () => {} }));
    await click(field(m.host, "Add a page by hand"));
    const title = m.host.querySelector("dialog input:not([type=file])") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      set?.call(title, "Cash report");
      title.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
    const file = m.host.querySelector("dialog input[type=file]") as HTMLInputElement;
    const html = "<h1>Cash</h1>";
    Object.defineProperty(file, "files", { value: [{ name: "cash.html", size: html.length, text: async () => html }], configurable: true });
    await act(async () => void file.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event));
    await flush();
    await click(field(m.host, "Add the page"));
    await flush();
    assert.deepEqual(callsOf("artifact_new").map((c) => c.input), [{ title: "Cash report", html }]);
    assert.match(openDialog(m.host).textContent ?? "", /The page links a file outside the document/);
    await m.unmount();
  });
});

describe("Page", () => {
  it("shows the viewer-address notice, not a frame, when the preview ticket fails with view_origin_missing", async () => {
    reset();
    const m = await mountPage();
    assert.equal(m.host.querySelector("h1")?.textContent, "Weekly operations");
    assert.equal(m.host.querySelector("iframe"), null);
    assert.match(m.host.querySelector(".la-sandbox")?.textContent ?? "", /Links and previews need the viewer address\. Ask Portal to redeploy the bridge\./);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream/);
    await m.unmount();
  });

  it("shows the preview in a sandboxed frame without a referrer when the ticket works", async () => {
    reset();
    stub.fail.artifact_preview_ticket = undefined;
    stub.out.artifact_preview_ticket = { url: "https://views.example.test/v/tbv_abc", version: 7, expiresAt: "2026-10-14T08:10:00.000Z" };
    const m = await mountPage();
    const frame = m.host.querySelector("iframe");
    assert.ok(frame);
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(frame.getAttribute("src"), "https://views.example.test/v/tbv_abc");
    await m.unmount();
  });

  it("lists the sources, schedule, links and versions of the page", async () => {
    reset();
    const m = await mountPage();
    const sources = within(m.host, "Data sources");
    assert.match(sources.textContent ?? "", /Open issues.*Approved/);
    assert.match(sources.textContent ?? "", /Client notes.*Waits for you/);
    assert.match(sources.textContent ?? "", /Task Board · issues_list · project Website · every 15 min · keeps id, title, status, owner · up to 200 rows/);
    assert.match(within(m.host, "Schedule").textContent ?? "", /Refreshes every 15 min/);
    assert.match(within(m.host, "Links").textContent ?? "", /Novak Dental.*Ends 21 Oct 2026 · latest version.*14 views/);
    const versions = within(m.host, "Versions");
    assert.match(versions.textContent ?? "", /Version 8.*waits for you/);
    assert.match(versions.textContent ?? "", /Version 7.*live/);
    assert.ok(![...m.host.querySelectorAll("button")].some((b) => b.textContent === "Refresh now"), "there is no owner refresh op");
    await m.unmount();
  });

  it("Approve sends source_approve with the exact digest and viewers false", async () => {
    reset();
    const m = await mountPage();
    await click(field(within(m.host, "Data sources"), "Approve"));
    await flush();
    assert.deepEqual(callsOf("source_approve").map((c) => c.input), [{ id: "art_weekly", key: "notes", digest: "sha256:bbbb", viewers: false }]);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("'Use in this page' in the review sends the viewers choice the person made", async () => {
    reset();
    const m = await mountPage();
    await click(field(within(m.host, "Review and share"), "Review and share"));
    const dialog = openDialog(m.host);
    const sw = [...dialog.querySelectorAll('input[role="switch"]')].find((s) => s.closest(".la-source")?.textContent?.includes("Client notes")) as HTMLInputElement;
    assert.ok(sw, "switch for the pending source");
    assert.equal(sw.checked, false, "off by default");
    await click(sw);
    await click(field(dialog, "Use in this page"));
    await flush();
    assert.deepEqual(callsOf("source_approve").map((c) => c.input), [{ id: "art_weekly", key: "notes", digest: "sha256:bbbb", viewers: true }]);
    await m.unmount();
  });

  it("a source that changed shows a plain sentence, never the raw answer", async () => {
    reset();
    stub.fail.source_approve = { status: 409, code: "digest_changed" };
    const m = await mountPage();
    await click(field(within(m.host, "Data sources"), "Approve"));
    await flush();
    assert.deepEqual(alerts(m.host), ["This source changed. Look at it again."]);
    assert.ok(callsOf("artifact_detail").length >= 2, "the page is read again");
    await m.unmount();
  });

  it("Make live sends publish_version with the page and the version", async () => {
    reset();
    const m = await mountPage();
    const staged = [...within(m.host, "Versions").querySelectorAll(".item")][0] as Element;
    await click(field(staged, "Make live"));
    await flush();
    assert.deepEqual(callsOf("publish_version").map((c) => c.input), [{ id: "art_weekly", version: 8 }]);
    await m.unmount();
  });

  it("C8: one call at a time; a button stays disabled while its call runs", async () => {
    reset();
    let release = () => {};
    stub.gate.source_approve = new Promise<void>((r) => {
      release = r;
    });
    const m = await mountPage();
    const approve = field(within(m.host, "Data sources"), "Approve");
    await click(approve);
    assert.ok(approve.disabled, "disabled while the call runs");
    assert.ok(field(within(m.host, "Data sources"), "Test read").disabled, "every action waits");
    await click(approve);
    await click(field(within(m.host, "Versions"), "Make live"));
    assert.equal(callsOf("source_approve").length, 1);
    assert.equal(callsOf("publish_version").length, 0);
    release();
    await flush();
    assert.equal(callsOf("source_approve").length, 1);
    assert.ok(!field(within(m.host, "Data sources"), "Approve").disabled, "back after the call");
    await m.unmount();
  });

  it("Test read shows sample rows; a refused read links to the source app's Configure page", async () => {
    reset();
    stub.out.source_test = { key: "notes", status: "ok", sample: [{ title: "Novak", date: "2026-10-01" }], rows: 1, code: null, configureLink: null };
    const m = await mountPage();
    const notes = [...within(m.host, "Data sources").querySelectorAll(".item")][1] as Element;
    await click(field(notes, "Test read"));
    await flush();
    assert.deepEqual(callsOf("source_test").map((c) => c.input), [{ id: "art_weekly", key: "notes" }]);
    assert.match(notes.textContent ?? "", /The read worked\. It gave 1 row/);
    assert.match(notes.querySelector("table")?.textContent ?? "", /Novak/);
    stub.out.source_test = { key: "notes", status: "error", sample: null, rows: null, code: "scope_denied", configureLink: "https://portal.example.test/a/knowledge/configure" };
    await click(field(notes, "Test read"));
    await flush();
    assert.match(notes.textContent ?? "", /does not share this data with Live Artifacts yet/);
    const link = notes.querySelector("a");
    assert.equal(link?.textContent, "Share it in Knowledge");
    assert.equal(link?.getAttribute("href"), "https://portal.example.test/a/knowledge/configure");
    await m.unmount();
  });

  it("Delete asks for a typed confirmation, then calls artifact_remove and leaves the page", async () => {
    reset();
    let gone = 0;
    const m = await mountPage(() => gone++);
    await click(field(m.host, "Delete"));
    const dialog = openDialog(m.host);
    const confirm = field(dialog, "Delete the page");
    assert.ok(confirm.disabled, "not before the word is typed");
    const input = dialog.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, "delete");
      input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
    await click(field(dialog, "Delete the page"));
    await flush();
    assert.deepEqual(callsOf("artifact_remove").map((c) => c.input), [{ id: "art_weekly" }]);
    assert.equal(gone, 1);
    await m.unmount();
  });

  it("Archive and the shared-page switch call their ops; a schedule is approved with its seconds", async () => {
    reset();
    const m = await mountPage();
    await click(field(m.host, "Archive"));
    await flush();
    await click(m.host.querySelector('input[role="switch"][type="checkbox"]') as Element);
    await flush();
    await click(field(within(m.host, "Schedule"), "Switch off"));
    await flush();
    assert.deepEqual(callsOf("artifact_archive").map((c) => c.input), [{ id: "art_weekly", archived: true }]);
    assert.deepEqual(callsOf("autopublish_set").map((c) => c.input), [{ id: "art_weekly", mode: "agent" }]);
    assert.deepEqual(callsOf("trigger_approve").map((c) => c.input), [{ id: "art_weekly", everySeconds: null }]);
    await m.unmount();
  });

  it("a missing page is an error with Try again", async () => {
    reset();
    stub.fail.artifact_detail = { status: 404, code: "not_found" };
    const m = await mountPage();
    assert.match(alerts(m.host)[0] ?? "", /That page is gone/);
    await m.unmount();
  });
});


// ── links (S4) ─────────────────────────────────────────────────────────────
const typeInto = (input: Element, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
/** Open the n-th select of `scope` and pick the option that starts with `text`. */
async function choose(scope: Element, n: number, text: string) {
  await click([...scope.querySelectorAll('[role="combobox"]')][n] as Element);
  const option = [...scope.ownerDocument.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(text));
  assert.ok(option, `option "${text}"`);
  await click(option);
}
const MADE = { linkId: "lnk_new", url: "https://views.example.test/v/live-artifacts/tbv_SECRETSECRETSECRETSECRETSECRETSECRETSECRET1", expiresAt: "2026-10-24T08:00:00.000Z" };
/** The viewer address works: previews open (the normal state once Portal redeployed the bridge). */
const viewerReady = () => {
  stub.fail.artifact_preview_ticket = undefined;
  stub.out.artifact_preview_ticket = { url: "https://views.example.test/v/live-artifacts/tbv_abc", version: 7, expiresAt: "2026-10-14T08:10:00.000Z" };
};
const LINK_ROWS = [
  { id: "lnk_a", artifactId: "art_weekly", artifactTitle: "Weekly operations", label: "Novak Dental", createdBy: { type: "person", id: "per_1", name: "Owner" }, createdAt: "2026-10-10T08:00:00.000Z", expiresAt: "2026-10-21T08:00:00.000Z", revokedAt: null, pinVersion: null, views: 14, lastSeenDay: "2026-10-13", status: "active" },
  { id: "lnk_b", artifactId: "art_weekly", artifactTitle: "Weekly operations", label: "Board meeting", createdBy: actor("Scout"), createdAt: "2026-10-10T08:00:00.000Z", expiresAt: "2026-10-16T08:00:00.000Z", revokedAt: null, pinVersion: 6, views: 3, lastSeenDay: "2026-10-12", status: "active" },
  { id: "lnk_c", artifactId: "art_hiring", artifactTitle: "Hiring pipeline", label: "Recruiter", createdBy: { type: "person", id: "per_1", name: "Owner" }, createdAt: "2026-10-01T08:00:00.000Z", expiresAt: "2026-10-08T08:00:00.000Z", revokedAt: "2026-10-05T08:00:00.000Z", pinVersion: null, views: 2, lastSeenDay: null, status: "revoked" },
  { id: "lnk_d", artifactId: "art_onboard", artifactTitle: "Client onboarding status", label: "", createdBy: { type: "person", id: "per_1", name: "Owner" }, createdAt: "2026-09-26T08:00:00.000Z", expiresAt: "2026-10-03T08:00:00.000Z", revokedAt: null, pinVersion: null, views: 21, lastSeenDay: "2026-09-07", status: "expired" },
];

describe("Links page", () => {
  it("lists every link of every page: page, label, who made it, end, views, status; Revoke only on active links", async () => {
    reset();
    stub.out.links_list = { items: LINK_ROWS, active: 2 };
    const m = await mount(h(links.LinksPage, { onOpen: () => {} }));
    assert.equal(m.host.querySelector("h1")?.textContent, "Links");
    assert.match(m.host.textContent ?? "", /A link is a secret address\. Anyone who has it can open the page until it ends or you revoke it/);
    const rows = [...m.host.querySelectorAll("tbody tr")];
    assert.deepEqual(
      rows.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent)),
      [
        ["Weekly operations", "Novak Dental", "you", "21 Oct 2026", "14", "Active", "Revoke"],
        ["Weekly operations", "Board meeting", "Scout, approved by you", "16 Oct 2026", "3", "Active", "Revoke"],
        ["Hiring pipeline", "Recruiter", "you", "8 Oct 2026", "2", "Revoked", ""],
        ["Client onboarding status", "No label", "you", "3 Oct 2026", "21", "Ended", ""],
      ],
    );
    assert.match(m.host.textContent ?? "", /2 links active\./);
    assert.doesNotMatch(m.host.textContent ?? "", /tbv_/, "no address on this page");
    await m.unmount();
  });

  it("opens the page of a link; an empty list says what to do; a failed load is an error with Try again", async () => {
    reset();
    stub.out.links_list = { items: LINK_ROWS, active: 2 };
    const opened: string[] = [];
    const m = await mount(h(links.LinksPage, { onOpen: (id: string) => opened.push(id) }));
    await click(field(m.host, "Hiring pipeline"));
    assert.deepEqual(opened, ["art_hiring"]);
    await m.unmount();
    reset();
    stub.out.links_list = { items: [], active: 0 };
    const empty = await mount(h(links.LinksPage, { onOpen: () => {} }));
    assert.match(empty.host.querySelector(".tb-empty")?.textContent ?? "", /No links yet/);
    await empty.unmount();
    reset();
    stub.fail.links_list = { status: 500, code: "internal" };
    const bad = await mount(h(links.LinksPage, { onOpen: () => {} }));
    assert.match(alerts(bad.host)[0] ?? "", /Something went wrong/);
    assert.equal(bad.host.querySelector(".tb-empty"), null, "not an empty list that looks like 'nothing here'");
    assert.equal(bad.host.querySelector("table"), null);
    await bad.unmount();
  });

  it("Revoke asks first (with the plain consequence), then sends link_revoke and reads the list again", async () => {
    reset();
    stub.out.links_list = { items: LINK_ROWS, active: 2 };
    const m = await mount(h(links.LinksPage, { onOpen: () => {} }));
    await click(field(m.host, "Revoke"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /People who have this link can no longer open the page\. It takes effect at once\./);
    assert.equal(callsOf("link_revoke").length, 0, "nothing is sent before the answer");
    await click(field(dialog, "Keep"));
    assert.equal(callsOf("link_revoke").length, 0);
    await click(field(m.host, "Revoke"));
    await click(field(openDialog(m.host), "Revoke the link"));
    await flush();
    assert.deepEqual(callsOf("link_revoke").map((c) => c.input), [{ linkId: "lnk_a" }]);
    assert.equal(callsOf("links_list").length, 2, "the list is read again");
    await m.unmount();
  });

  it("a failed revoke is a plain sentence in the dialog, never the raw answer", async () => {
    reset();
    stub.out.links_list = { items: LINK_ROWS, active: 2 };
    stub.fail.link_revoke = { status: 404, code: "link_not_found" };
    const m = await mount(h(links.LinksPage, { onOpen: () => {} }));
    await click(field(m.host, "Revoke"));
    await click(field(openDialog(m.host), "Revoke the link"));
    await flush();
    assert.match(openDialog(m.host).textContent ?? "", /That link is gone\. Reload the page and look again\./);
    assert.doesNotMatch(m.host.textContent ?? "", /raw upstream/);
    await m.unmount();
  });
});

describe("Page: links", () => {
  it("Create link: label, lifetime and version go into link_create; the address is shown once, with Copy", async () => {
    reset();
    viewerReady();
    stub.out.link_create = MADE;
    const m = await mountPage();
    await click(field(within(m.host, "Links"), "Create link"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /Anyone who has the address can open this page without an account/);
    await typeInto(dialog.querySelector("input") as Element, "Board");
    await choose(dialog, 0, "30 days");
    await choose(dialog, 1, "Only version 6");
    await click(field(dialog, "Create link"));
    await flush();
    assert.deepEqual(callsOf("link_create").map((c) => c.input), [{ id: "art_weekly", label: "Board", expiresInDays: 30, pin: 6 }]);
    const shown = openDialog(m.host);
    assert.match(shown.textContent ?? "", /The link is ready/);
    assert.match(shown.textContent ?? "", /tbv_SECRETSECRET/);
    assert.match(shown.textContent ?? "", /the app shows it only once\. The list of links keeps a fingerprint.*sealed, so a repeated request gets the same address/);
    assert.ok(field(shown, "Copy"), "a Copy button");
    assert.deepEqual(alerts(m.host), []);
    await click(field(shown, "Done"));
    await flush();
    assert.doesNotMatch(m.host.textContent ?? "", /tbv_SECRET/, "the address is gone once the dialog is closed");
    await m.unmount();
  });

  it("the default is the owner's lifetime and the live version: only what was chosen is sent", async () => {
    reset();
    viewerReady();
    stub.out.link_create = MADE;
    const m = await mountPage();
    await click(field(within(m.host, "Links"), "Create link"));
    await click(field(openDialog(m.host), "Create link"));
    await flush();
    assert.deepEqual(callsOf("link_create").map((c) => c.input), [{ id: "art_weekly", expiresInDays: 7 }], "no label, no pin");
    await m.unmount();
  });

  it("without a viewer address the form says so and Create is off; a refusal from the server is the same plain sentence", async () => {
    reset(); // preview ticket: view_origin_missing
    const m = await mountPage();
    await click(field(within(m.host, "Links"), "Create link"));
    const dialog = openDialog(m.host);
    assert.match(dialog.textContent ?? "", /Links and previews need the viewer address/);
    assert.ok(field(dialog, "Create link").disabled);
    await m.unmount();
    reset();
    viewerReady();
    stub.fail.link_create = { status: 409, code: "view_origin_missing" };
    const late = await mountPage();
    await click(field(within(late.host, "Links"), "Create link"));
    await click(field(openDialog(late.host), "Create link"));
    await flush();
    assert.match(openDialog(late.host).textContent ?? "", /Links and previews need the viewer address\. Ask Portal to redeploy the bridge\./);
    assert.doesNotMatch(late.host.textContent ?? "", /raw upstream/);
    await late.unmount();
  });

  it("the caps are plain sentences", async () => {
    for (const [code, text] of [
      ["links_limit_artifact", /This page has 5 active links\. Revoke one first\./],
      ["links_limit_workspace", /The workspace has 50 active links\. Revoke one first\./],
    ] as const) {
      reset();
      viewerReady();
      stub.fail.link_create = { status: 409, code };
      const m = await mountPage();
      await click(field(within(m.host, "Links"), "Create link"));
      await click(field(openDialog(m.host), "Create link"));
      await flush();
      assert.match(openDialog(m.host).textContent ?? "", text);
      await m.unmount();
    }
  });

  it("an archived page offers no new link", async () => {
    reset();
    viewerReady();
    stub.out.artifact_detail = { ...DETAIL, artifact: { ...DETAIL.artifact, status: "archived" } };
    const m = await mountPage();
    assert.ok(field(within(m.host, "Links"), "Create link").disabled);
    await m.unmount();
  });

  it("Revoke on a link asks first, then calls link_revoke and reads the page again; ended links have no Revoke", async () => {
    reset();
    stub.out.artifact_detail = {
      ...DETAIL,
      links: [...DETAIL.links, { ...DETAIL.links[0], id: "lnk_2", label: "Old", status: "expired", views: 1, lastSeenDay: null }, { ...DETAIL.links[0], id: "lnk_3", label: "Gone", status: "revoked", revokedAt: "2026-10-12T08:00:00.000Z" }],
    };
    const m = await mountPage();
    const box = within(m.host, "Links");
    assert.equal([...box.querySelectorAll("button")].filter((b) => b.textContent === "Revoke").length, 1);
    assert.match(box.textContent ?? "", /Old.*Ended/);
    assert.match(box.textContent ?? "", /Gone.*Revoked/);
    const before = callsOf("artifact_detail").length;
    await click(field(box, "Revoke"));
    assert.equal(callsOf("link_revoke").length, 0);
    await click(field(openDialog(m.host), "Revoke the link"));
    await flush();
    assert.deepEqual(callsOf("link_revoke").map((c) => c.input), [{ linkId: "lnk_1" }]);
    assert.ok(callsOf("artifact_detail").length > before, "the page is read again");
    await m.unmount();
  });
});

describe("Review and share: step 3", () => {
  async function toStep3(m: Awaited<ReturnType<typeof mount>>) {
    await click(field(within(m.host, "Review and share"), "Review and share"));
    const dialog = openDialog(m.host);
    // a step change fades out and in (the kit's --tb-dur-step), so wait for it
    const settle = () => act(async () => new Promise((r) => setTimeout(r, 500)));
    await click(field(dialog, "Next"));
    await settle();
    await click(field(dialog, "Next"));
    await settle();
    return dialog;
  }
  it("shows the form and the limits in plain words; Create link makes the link, shows the address once, Done closes", async () => {
    reset();
    viewerReady();
    stub.out.link_create = MADE;
    const m = await mountPage();
    const dialog = await toStep3(m);
    assert.match(dialog.textContent ?? "", /Who may open this page\?/);
    assert.match(dialog.textContent ?? "", /Anyone who has the address can open it until it ends or you revoke it/);
    assert.match(dialog.textContent ?? "", /What a link cannot promise/);
    assert.match(dialog.textContent ?? "", /In some browsers page code can contact outside sites/);
    assert.match(dialog.textContent ?? "", /Everything the page shows can be copied by whoever sees it/);
    assert.match(dialog.textContent ?? "", /wait for you before link holders see them/);
    assert.match(dialog.textContent ?? "", /1 link of this page is active\. At most 5\./);
    assert.ok(field(dialog, "Finish without a link"), "Skip has its own words");
    await typeInto(dialog.querySelector('input[type="text"], input:not([type])') as Element, "Accountant");
    await choose(dialog, 0, "1 day");
    await click(field(dialog, "Create link"));
    await flush();
    assert.deepEqual(callsOf("link_create").map((c) => c.input), [{ id: "art_weekly", label: "Accountant", expiresInDays: 1 }]);
    assert.match(dialog.textContent ?? "", /The link is ready/);
    assert.match(dialog.textContent ?? "", /tbv_SECRETSECRET/);
    assert.equal(callsOf("link_create").length, 1);
    await click(field(dialog, "Done"));
    await flush();
    assert.doesNotMatch(m.host.textContent ?? "", /tbv_SECRET/, "closed: the address is gone");
    assert.equal(callsOf("link_create").length, 1, "Done sends nothing");
    await m.unmount();
  });
  it("without a viewer address Create link is off and the notice says why; Finish without a link closes", async () => {
    reset(); // preview ticket: view_origin_missing
    const m = await mountPage();
    const dialog = await toStep3(m);
    assert.match(dialog.textContent ?? "", /Links and previews need the viewer address/);
    assert.ok(field(dialog, "Create link").disabled);
    await click(field(dialog, "Finish without a link"));
    await flush();
    assert.equal(callsOf("link_create").length, 0);
    assert.equal(
      [...m.host.querySelectorAll("dialog")].filter((d) => d.childElementCount > 0).length,
      0,
      "the review is closed",
    );
    await m.unmount();
  });
  it("a refused link keeps the step open with a plain sentence", async () => {
    reset();
    viewerReady();
    stub.fail.link_create = { status: 409, code: "links_limit_artifact" };
    const m = await mountPage();
    const dialog = await toStep3(m);
    await click(field(dialog, "Create link"));
    await flush();
    assert.match(dialog.textContent ?? "", /This page has 5 active links\. Revoke one first\./);
    assert.ok(field(dialog, "Create link"), "still on the step");
    await m.unmount();
  });
  it("step 2 lists pushed sources too, so the owner can show pushed numbers to link viewers", async () => {
    reset();
    const push = { ...SRC_OK, key: "numbers", kind: "push", label: "Weekly numbers", product: null, op: null, input: null, projection: null, digest: "sha256:cccc", viewers: false, approved: true };
    stub.out.artifact_detail = { ...DETAIL, sources: [SRC_OK, push] };
    const m = await mountPage();
    await click(field(within(m.host, "Review and share"), "Review and share"));
    const dialog = openDialog(m.host);
    await click(field(dialog, "Next"));
    const sw = [...dialog.querySelectorAll('input[role="switch"]')].find((x) => x.closest(".la-source")?.textContent?.includes("Weekly numbers")) as HTMLInputElement;
    assert.ok(sw, "a switch for the pushed source");
    await click(sw);
    await flush();
    assert.deepEqual(callsOf("source_approve").map((c) => c.input), [{ id: "art_weekly", key: "numbers", digest: "sha256:cccc", viewers: true }]);
    await m.unmount();
  });
});

describe("Settings", () => {
  it("shows the saved link lifetime and saves another with settings_set", async () => {
    reset();
    const m = await mount(h(settings.SettingsPage, {}));
    assert.equal(m.host.querySelector(".tb-select-value")?.textContent, "7 days");
    assert.match(m.host.textContent ?? "", /Ready/, "the viewer address is there");
    assert.doesNotMatch(m.host.textContent ?? "", /Not set yet/);
    await click(m.host.querySelector('[role="combobox"]') as Element);
    const option = [...m.host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith("30 days"));
    assert.ok(option);
    await click(option);
    await flush();
    assert.deepEqual(callsOf("settings_set").map((c) => c.input), [{ defaultLinkDays: 30 }]);
    await m.unmount();
  });
});

describe("Settings: viewer address", () => {
  it("says Not set yet when the server reports the missing viewer address", async () => {
    reset();
    stub.out.gallery_view = { galleries: [], items: [], nextCursor: null, counts: COUNTS, notices: [{ code: "view_origin_missing", message: "x" }], settings: { defaultLinkDays: 7 } };
    const m = await mount(h(settings.SettingsPage, {}));
    assert.match(m.host.textContent ?? "", /Not set yet/);
    assert.match(m.host.textContent ?? "", /Ask Portal to redeploy the bridge/);
    await m.unmount();
  });
});

describe("App", () => {
  it("opens /page/<id> (the server's review link) on the Page and keeps the nav order", async () => {
    reset();
    win.history.pushState(null, "", "/a/live-artifacts/page/art_weekly");
    const m = await mount(h(app.App, {}));
    assert.equal(m.host.querySelector(".app-page h1")?.textContent, "Weekly operations");
    assert.deepEqual(callsOf("artifact_detail").map((c) => c.input), [{ id: "art_weekly" }]);
    const nav = [...m.host.querySelectorAll("nav a")].map((a) => a.textContent?.replace(/\d+$/, "").trim());
    assert.deepEqual(nav.slice(0, 8), ["Gallery", "Page", "Links", "Holds", "Receipts", "Agents & scopes", "Settings", "Backups & export"]);
    await m.unmount();
    win.history.pushState(null, "", "/a/live-artifacts/");
  });
  it("/links opens the Links page", async () => {
    reset();
    stub.out.links_list = { items: LINK_ROWS, active: 2 };
    win.history.pushState(null, "", "/a/live-artifacts/links");
    const m = await mount(h(app.App, {}));
    assert.equal(m.host.querySelector(".app-page h1")?.textContent, "Links");
    assert.equal(callsOf("links_list").length, 1);
    assert.equal(m.host.querySelectorAll("tbody tr").length, 4);
    await m.unmount();
    win.history.pushState(null, "", "/a/live-artifacts/");
  });
});
