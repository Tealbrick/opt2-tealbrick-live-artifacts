// The standard Holds page (src/ui/standard.tsx) against the real SDK client and a stub server:
// RUL-01 (a failed decision shows a message), RUL-14 (a failed load is an error, not an empty list), C8 (one call at a
// time per hold). The page is compiled with the build tsconfig into dist/ui-test (JSX needs a compile) and rendered in
// happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Standard = typeof import("../src/ui/standard.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/kanban/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server (the standard ops under /a/kanban/tb/v1/) ───────────────────
const ULID = "01HZX3K8Q2V4N6P8R0S2T4V6W8";
type StubHold = { id: string; caller: { type: "agent"; id: string; name: string }; op: string; holdFamily: string | null; heldBy: string | null; summary: string; view?: string; status: "held" };
const hold = (n: number, caller: string, op: string, summary: string, extra: Partial<StubHold> = {}): StubHold => ({
  id: `hld_${ULID.slice(0, 25)}${n}`,
  caller: { type: "agent", id: `agt_${n}`, name: caller },
  op,
  holdFamily: null,
  heldBy: null,
  summary,
  status: "held",
  ...extra,
});
const A = hold(1, "Research partner", "issue_delete", "Delete issue “Old price list”", { holdFamily: "delete", view: "issue: Old price list\nproject: Launch" });
const B = hold(2, "Front desk", "issue_move", "Move “Draft letters” to Done");

interface Stub {
  holds: StubHold[];
  calls: { op: string; input: unknown }[];
  /** per-op override: return an error envelope (status, code) or a promise to hold the answer */
  fail: Record<string, { status: number; code: string } | undefined>;
  gate: Record<string, Promise<void> | undefined>;
  networkDown: boolean;
}
const stub: Stub = { holds: [], calls: [], fail: {}, gate: {}, networkDown: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (stub.networkDown) throw new TypeError("fetch failed");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/kanban/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "tb.holds_list") return json(200, { status: "ok", output: { items: stub.holds, nextCursor: null } });
  if (op === "tb.holds_decide") {
    const id = (body.input as { holdId: string }).holdId;
    stub.holds = stub.holds.filter((h) => h.id !== id);
    return json(200, { status: "ok", output: {} });
  }
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "kanban" }, el)));
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
const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const rows = (host: Element) => [...host.querySelectorAll(".item")];
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");

let std: Standard;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  std = (await import(pathToFileURL(join(outDir, "ui", "standard.js")).href)) as Standard;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const reset = (holds: StubHold[]) => {
  stub.holds = [...holds];
  stub.calls = [];
  stub.fail = {};
  stub.gate = {};
  stub.networkDown = false;
};

describe("Holds page", () => {
  it("lists held calls: caller, summary, op tag, view, Approve (primary) and Deny", async () => {
    reset([A, B]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits for your approval." }));
    assert.equal(m.host.querySelector("h1")?.textContent, "Holds");
    assert.equal(rows(m.host).length, 2);
    const first = rows(m.host)[0] as Element;
    assert.equal(first.querySelector("h3")?.textContent, "Research partner");
    assert.match(first.textContent ?? "", /Delete issue “Old price list”/);
    assert.match(first.querySelector(".tb-tag.needs-you")?.textContent ?? "", /issue_delete/);
    assert.match(first.querySelector("pre.view")?.textContent ?? "", /project: Launch/);
    assert.ok(button(first, "Approve").className.includes("primary"));
    assert.ok(!button(first, "Deny").className.includes("primary"));
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("RUL-01 fires: a failed decision shows a plain message in an alert and keeps the row", async () => {
    reset([A, B]);
    stub.fail["tb.holds_decide"] = { status: 409, code: "hold_expired" };
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    await click(button(rows(m.host)[0] as Element, "Approve"));
    await flush();
    const [message] = alerts(m.host);
    assert.match(message ?? "", /expired before you decided/);
    assert.doesNotMatch(message ?? "", /raw upstream/, "never the raw upstream text");
    assert.equal(rows(m.host).length, 2, "the list is reloaded and still has both (stub keeps them)");
    assert.ok(!button(rows(m.host)[0] as Element, "Approve").disabled, "buttons are back after the call");
    await m.unmount();
  });

  it("RUL-01 fires for a network error and a signed-out session", async () => {
    reset([A]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    stub.fail["tb.holds_decide"] = { status: 401, code: "session_required" };
    await click(button(m.host, "Deny"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /signed out/);
    stub.fail["tb.holds_decide"] = undefined;
    stub.networkDown = true;
    await click(button(m.host, "Deny"));
    await flush();
    assert.ok(alerts(m.host).some((a) => /reach the app/.test(a)));
    await m.unmount();
  });

  it("RUL-01 quiet: a decision that goes through removes the row and shows no alert", async () => {
    reset([A, B]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    await click(button(rows(m.host)[0] as Element, "Approve"));
    await flush();
    assert.deepEqual(stub.calls.filter((c) => c.op === "tb.holds_decide").map((c) => c.input), [{ holdId: A.id, decision: "approve" }]);
    assert.equal(rows(m.host).length, 1);
    assert.equal(rows(m.host)[0]?.querySelector("h3")?.textContent, "Front desk");
    assert.deepEqual(alerts(m.host), []);
    await click(button(m.host, "Deny"));
    await flush();
    assert.equal(rows(m.host).length, 0);
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "Nothing waits.", "the app's own empty sentence");
    await m.unmount();
  });

  it("C8: while a decision runs its buttons are disabled and a second click sends nothing", async () => {
    reset([A, B]);
    let release = () => {};
    stub.gate["tb.holds_decide"] = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    const approve = button(rows(m.host)[0] as Element, "Approve");
    await act(async () => {
      approve.click(); // two clicks before React re-renders: the second must be ignored
      approve.click();
    });
    assert.ok(approve.disabled && button(rows(m.host)[0] as Element, "Deny").disabled, "both buttons of that hold are disabled");
    assert.ok(!button(rows(m.host)[1] as Element, "Approve").disabled, "other holds are not blocked");
    assert.equal(stub.calls.filter((c) => c.op === "tb.holds_decide").length, 1);
    release();
    await flush();
    assert.equal(rows(m.host).length, 1);
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not an empty state; Try again loads", async () => {
    reset([A]);
    stub.fail["tb.holds_list"] = { status: 500, code: "internal_error" };
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null, "no false empty state");
    stub.fail["tb.holds_list"] = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.deepEqual(alerts(m.host), []);
    assert.equal(rows(m.host).length, 1);
    await m.unmount();
  });

  it("deep link: only the named hold; a gone hold says so", async () => {
    reset([A, B]);
    let m = await mount(h(std.HoldsPage, { empty: "Nothing waits.", only: B.id }));
    assert.equal(rows(m.host).length, 1);
    assert.equal(rows(m.host)[0]?.querySelector("h3")?.textContent, "Front desk");
    await m.unmount();
    m = await mount(h(std.HoldsPage, { empty: "Nothing waits.", only: `hld_${ULID.slice(0, 25)}9` }));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "This approval is no longer waiting.");
    await m.unmount();
  });
});

describe("helpers", () => {
  it("decideOrError returns the message, or null when it went through", async () => {
    const expired = async () => {
      throw Object.assign(new Error("raw"), { code: "hold_expired" });
    };
    assert.match((await std.decideOrError(expired, "hld_1", "approve")) ?? "", /expired/);
    assert.equal(await std.decideOrError(async () => {}, "hld_1", "deny"), null);
    assert.equal(std.errorMessage("not an Error"), "Something went wrong. Try again in a moment.");
  });

  it("portalHref: only an https tealbrick.com origin is the Portal link; anything else is the app's own launch page", () => {
    sessionStorage.clear();
    for (const referrer of ["", "https://evil.example/page", "http://dev.tealbrick.com/", "https://tealbrick.com.evil.example/", "https://eviltealbrick.com/", "https://portal.tealbrick.com@evil.example/", "not a url"])
      assert.equal(std.portalHref(referrer), "./", `not used: ${referrer}`);
    assert.equal(std.portalHref("https://dev.tealbrick.com/canvas?x=1"), "https://dev.tealbrick.com/");
    assert.equal(std.portalHref("https://tealbrick.com/"), "https://tealbrick.com/");
    // remembered for a reload without a referrer; a foreign value in storage is ignored
    sessionStorage.setItem("tb.portalOrigin", "https://dev.tealbrick.com");
    assert.equal(std.portalHref(""), "https://dev.tealbrick.com/");
    sessionStorage.setItem("tb.portalOrigin", "https://evil.example");
    assert.equal(std.portalHref(""), "./");
    sessionStorage.clear();
  });

  it("the router maps paths to pages under the base and finds a /holds/<id> deep link", () => {
    const routes = std.standardRoutes("board");
    const base = "/a/kanban/";
    assert.deepEqual(routes, { board: "", holds: "holds", receipts: "receipts", agents: "configure", backups: "backups" });
    assert.equal(std.pageOf(routes, base, "/a/kanban/", "board"), "board");
    assert.equal(std.pageOf(routes, base, "/a/kanban/configure/", "board"), "agents");
    assert.equal(std.pageOf(routes, base, "/a/kanban/receipts", "board"), "receipts");
    assert.equal(std.pageOf(routes, base, "/a/kanban/nope", "board"), "board");
    assert.equal(std.pageOf(std.standardRoutes(), base, "/a/kanban/", "holds"), "holds");
    assert.equal(std.pageOf(routes, base, `/a/kanban/holds/hld_${ULID}`, "board"), "holds");
    assert.equal(std.holdOf(`/a/kanban/holds/hld_${ULID}/`), `hld_${ULID}`);
    assert.equal(std.holdOf("/a/kanban/holds/hld_short"), null);
  });
});
