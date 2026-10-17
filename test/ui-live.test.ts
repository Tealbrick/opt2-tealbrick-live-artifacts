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
type AppModule = typeof import("../src/ui/App.tsx");
let gallery: Gallery;
let page: Page;
let settings: Settings;
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
    assert.match(m.host.querySelector(".la-sandbox")?.textContent ?? "", /Previews need the viewer address\. Ask Portal to redeploy the bridge\./);
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
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
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
    assert.match(dialog.textContent ?? "", /Links come in the next version/);
    assert.ok(field(dialog, "Create link").disabled);
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

describe("Settings", () => {
  it("shows the saved link lifetime and saves another with settings_set", async () => {
    reset();
    const m = await mount(h(settings.SettingsPage, {}));
    assert.equal(m.host.querySelector(".tb-select-value")?.textContent, "7 days");
    assert.match(m.host.textContent ?? "", /Not set yet/);
    await click(m.host.querySelector('[role="combobox"]') as Element);
    const option = [...m.host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith("30 days"));
    assert.ok(option);
    await click(option);
    await flush();
    assert.deepEqual(callsOf("settings_set").map((c) => c.input), [{ defaultLinkDays: 30 }]);
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
    assert.deepEqual(nav.slice(0, 7), ["Gallery", "Page", "Holds", "Receipts", "Agents & scopes", "Settings", "Backups & export"]);
    await m.unmount();
    win.history.pushState(null, "", "/a/live-artifacts/");
  });
});
