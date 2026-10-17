// The SDK standard pages of every mini app (Holds, Receipts, Agents & scopes, Backups & export) and the small page
// router they need, drawn with @opt2-tealbrick/ui only. ONE source: the miniapp template. Apps copy this file
// unchanged to src/ui/standard.tsx and pass their own words as props; no app name or id is in here.
//
// Rules this file keeps for every app (do not weaken them in a copy):
// - RUL-01: a failed Approve / Deny shows a plain message in a Notice (role="alert"); it is never dropped.
// - RUL-14: a failed load shows an error with Try again, never an empty state that looks like "nothing here".
// - C8: one decide call at a time per hold; its buttons stay disabled while the call runs.
// The SDK hooks useHolds / useAgents keep the last data when a load fails, so a failed load looks empty. These
// pages therefore call the same standard ops (tb.holds_list, tb.holds_decide, tb.receipts_list, tb.agents_list,
// tb.export) through callOp / tbFetch and keep the load error.
import { callOp, tbFetch, type UseAgents, type UseHolds } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Notice, Swatch, Table, Tag } from "@opt2-tealbrick/ui";
import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

// ── messages ────────────────────────────────────────────────────────────────

const SIGNED_OUT = "You’re signed out. Open this app from Portal to sign in again.";

/** Plain sentence for a failed call: the cause and what to do (design §6, L18). Never raw upstream text. */
export function errorMessage(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; httpStatus?: unknown };
  switch (err.code) {
    case "hold_expired":
      return "This approval expired before you decided. Ask the agent to try again.";
    case "hold_decided":
      return "This approval was already decided.";
    case "hold_not_found":
      return "This approval is no longer waiting.";
    case "session_required":
    case "csrf_invalid":
      return SIGNED_OUT;
    case "network_error":
      return "Can’t reach the app. Check your connection and try again.";
    default:
      return err.httpStatus === 401 ? SIGNED_OUT : "Something went wrong. Try again in a moment.";
  }
}

/** A decision that failed because the hold is gone or was settled: the row is stale and the list must reload. */
const STALE_CODES = new Set(["hold_expired", "hold_decided", "hold_not_found"]);
const isStale = (e: unknown) => STALE_CODES.has((e as { code?: unknown } | null)?.code as string);

/**
 * RUL-01: Approve / Deny must reach the owner as a message, never as an unhandled rejection.
 * Returns the message, or null when the decision went through.
 */
export async function decideOrError<D extends string>(decide: (id: string, decision: D) => Promise<void>, id: string, decision: D): Promise<string | null> {
  try {
    await decide(id, decision);
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

// ── page router ─────────────────────────────────────────────────────────────

/** Shell page id → path below the app base `/a/<id>/` ("" = the launch path). */
export type Routes = Readonly<Record<string, string>>;

const STANDARD_PATHS = { holds: "holds", receipts: "receipts", agents: "configure", backups: "backups" } as const;

/**
 * Routes of the standard pages. `launch` = the id of the app's own first page (it takes the launch path, manifest
 * `ui.launchPath`); without it the Holds page is the launch page. `agents` is always `/configure` (`ui.configurePath`).
 */
export function standardRoutes(launch?: string): Record<string, string> {
  return launch ? { [launch]: "", ...STANDARD_PATHS } : { ...STANDARD_PATHS, holds: "" };
}

const HOLD_PATH = /(?:^|\/)holds\/(hld_[0-9A-HJKMNP-TV-Z]{26})\/?$/;
/** SDK 0.1.13 (G4): `tb.holds_pending` decidePath `/holds/<id>` opens the app here; show that hold only. */
export const holdOf = (pathname: string): string | null => HOLD_PATH.exec(pathname)?.[1] ?? null;

const hrefOf = (routes: Routes, id: string) => `./${routes[id] ?? ""}`;

/** Page id of a URL path: a `/holds/<id>` deep link is the holds page; an unknown path is `fallback`. */
export function pageOf(routes: Routes, base: string, pathname: string, fallback: string): string {
  if (holdOf(pathname)) return "holds";
  const rest = (pathname.startsWith(base) ? pathname.slice(base.length) : "").replace(/\/+$/, "");
  return Object.keys(routes).find((id) => routes[id] === rest) ?? fallback;
}

export interface Nav {
  /** current page id */
  page: string;
  /** hold id of a `/holds/<id>` deep link, else null */
  hold: string | null;
  /** go to a page (history.pushState; the back button works) */
  go: (id: string) => void;
  /** real link target of a page, for the shell's `pageHref` (open in a new tab keeps working) */
  href: (id: string) => string;
}

/** Page state from the URL under the app base (`<base href>`); follows the back button. */
export function useNav(routes: Routes, fallback: string): Nav {
  const read = useCallback(() => {
    const { pathname } = globalThis.location;
    return { page: pageOf(routes, new URL(document.baseURI).pathname, pathname, fallback), hold: holdOf(pathname) };
  }, [routes, fallback]);
  const [at, setAt] = useState(read);
  useEffect(() => {
    const onPop = () => setAt(read());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, [read]);
  const go = useCallback(
    (id: string) => {
      globalThis.history.pushState(null, "", hrefOf(routes, id));
      setAt(read());
    },
    [routes, read],
  );
  return { ...at, go, href: (id) => hrefOf(routes, id) };
}

const PORTAL_KEY = "tb.portalOrigin";
/** Only a Tealbrick origin may become the Portal link: https and tealbrick.com or a subdomain of it. */
const trustedOrigin = (url: string): string | null => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const ours = host === "tealbrick.com" || host.endsWith(".tealbrick.com");
    return u.protocol === "https:" && ours && u.origin !== globalThis.location.origin ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * Where the shell's Tealbrick mark links to. Interim (the session carries no Portal URL): the origin the owner came
 * from (`document.referrer`) when it is https on tealbrick.com or a subdomain (any other site that links here must not
 * become the Portal link), remembered in sessionStorage for reloads; else the app's own launch page, never "/" of the
 * bridge host. Replace with the Portal URL as soon as the session or the manifest carries it.
 */
export function portalHref(referrer: string = document.referrer): string {
  let remembered: string | null = null;
  try {
    remembered = sessionStorage.getItem(PORTAL_KEY);
  } catch {
    // storage blocked: fall through to the referrer
  }
  const origin = trustedOrigin(referrer) ?? (remembered ? trustedOrigin(remembered) : null);
  if (!origin) return "./";
  try {
    sessionStorage.setItem(PORTAL_KEY, origin);
  } catch {
    // storage blocked: the referrer is read again next load
  }
  return `${origin}/`;
}

// ── shared bits ─────────────────────────────────────────────────────────────

export type Hold = UseHolds["holds"][number];
export type Agent = UseAgents["agents"][number];

/** Load state with the error kept (RUL-14). `load` must be stable (module function or useCallback). */
function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void>; set: Dispatch<SetStateAction<T | null>> } {
  const [data, set] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await load();
      if (mine !== seq.current) return;
      set(v);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, set };
}

/** A failed load: what happened, and a Try again button. */
function LoadError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p className="tb-soft" role="status">
      Loading {what}.
    </p>
  );
}

function Head({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {lede ? <p className="tb-lede">{lede}</p> : null}
    </div>
  );
}

// ── Holds ───────────────────────────────────────────────────────────────────

const MAX_PAGES = 20;
async function loadHolds(): Promise<Hold[]> {
  const out: Hold[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: { items: Hold[]; nextCursor: string | null } = await callOp("tb.holds_list", cursor ? { status: "held", cursor } : { status: "held" });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export interface HoldList {
  /** held calls; null until the first load worked */
  holds: readonly Hold[] | null;
  loading: boolean;
  /** plain message of the last failed load, else null */
  error: string | null;
  reload: () => Promise<void>;
  /** approve or deny; throws the SDK error (use decideOrError for a message). The hold leaves the list when it worked. */
  decide: (id: string, decision: "approve" | "deny") => Promise<void>;
}

/**
 * The held calls of this app (`tb.holds_list`), with the load error kept. Call it once in the app and pass the result
 * to <HoldsPage list> when the nav shows a count; <HoldsPage> loads its own list otherwise.
 */
export function useHoldList(): HoldList {
  const { data, error, loading, reload, set } = useLoad(loadHolds);
  const decide = useCallback(
    async (id: string, decision: "approve" | "deny") => {
      await callOp("tb.holds_decide", { holdId: id, decision });
      set((cur) => (cur ?? []).filter((h) => h.id !== id));
      await reload();
    },
    [reload, set],
  );
  return { holds: data, loading, error, reload, decide };
}

function HoldRow({ hold, busy, onDecide }: { hold: Hold; busy: boolean; onDecide: (decision: "approve" | "deny") => void }) {
  return (
    <div className="item">
      <Swatch className="is-needs-you" />
      <h3>{hold.caller.name}</h3>
      <p>{hold.summary}</p>
      <span className="meta">
        <Tag status="needs-you">{hold.op}</Tag>
        {hold.holdFamily ? <Tag>{hold.holdFamily}</Tag> : null}
        {hold.heldBy ? <Tag>{`held by ${hold.heldBy}`}</Tag> : null}
      </span>
      {hold.view ? <pre className="view">{hold.view}</pre> : null}
      <div className="side">
        <Button variant="primary" size="sm" disabled={busy} aria-label={`Approve ${hold.op} from ${hold.caller.name}`} onClick={() => onDecide("approve")}>
          Approve
        </Button>
        <Button size="sm" disabled={busy} aria-label={`Deny ${hold.op} from ${hold.caller.name}`} onClick={() => onDecide("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function HoldsView({ list, empty, lede, only }: { list: HoldList; empty: string; lede?: ReactNode; only?: string | null }) {
  const inflight = useRef(new Set<string>());
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const decide = async (id: string, decision: "approve" | "deny") => {
    if (inflight.current.has(id)) return; // C8: one call at a time per hold
    inflight.current.add(id);
    setBusy([...inflight.current]);
    setFailure(null);
    try {
      let stale = false;
      const message = await decideOrError(
        async (i, d) => {
          try {
            await list.decide(i, d);
          } catch (e) {
            stale = isStale(e);
            throw e;
          }
        },
        id,
        decision,
      );
      if (message) setFailure(message);
      if (stale) void list.reload(); // the row is out of date (expired or decided elsewhere): show the list as it is now
    } finally {
      inflight.current.delete(id);
      setBusy([...inflight.current]);
    }
  };
  const retry = () => {
    setFailure(null);
    void list.reload();
  };
  const holds = list.holds === null ? null : only ? list.holds.filter((h) => h.id === only) : list.holds;
  return (
    <section className="app-page" aria-label="Holds">
      <Head title="Holds" lede={lede} />
      {list.error ? <LoadError message={list.error} retrying={list.loading} onRetry={retry} /> : null}
      {failure ? (
        <Notice tone="needs-you" role="alert">
          {failure}
        </Notice>
      ) : null}
      {holds === null ? (
        list.error ? null : <Loading what="holds" />
      ) : holds.length === 0 ? (
        <EmptyState title={only ? "This approval is no longer waiting." : empty} />
      ) : (
        <div className="ruled">
          {holds.map((h) => (
            <HoldRow key={h.id} hold={h} busy={busy.includes(h.id)} onDecide={(d) => void decide(h.id, d)} />
          ))}
        </div>
      )}
    </section>
  );
}

function OwnHolds(props: Omit<HoldsPageProps, "list">) {
  return <HoldsView list={useHoldList()} {...props} />;
}

export interface HoldsPageProps {
  /** the app's own sentence for "nothing waits" (what its holds usually are) */
  empty: string;
  /** one line under the heading */
  lede?: ReactNode;
  /** `/holds/<id>` deep link (Nav.hold): show only this hold */
  only?: string | null;
  /** the list from useHoldList() when the app also shows the count; omit and the page loads its own */
  list?: HoldList;
}

/** Holds: calls that wait for the owner. Approve (primary) / Deny per row; errors in a Notice (RUL-01, RUL-14, C8). */
export function HoldsPage({ list, ...rest }: HoldsPageProps) {
  return list ? <HoldsView list={list} {...rest} /> : <OwnHolds {...rest} />;
}

// ── Receipts ────────────────────────────────────────────────────────────────

interface ReceiptRow {
  id: string;
  caller: { name: string };
  op: string;
  status: string;
  summary: string;
  createdAt: number;
}
type ReceiptPage = { items: ReceiptRow[]; nextCursor: string | null };

const RECEIPT_STATUS = { run: "live", approved: "live", held: "needs-you" } as const;

/** Time of day for today, else the short date and the time. */
function when(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

const loadReceipts = () => callOp<ReceiptPage>("tb.receipts_list", {});

/** Receipts: what agents changed, newest first (`tb.receipts_list`), as a ledger table. */
export function ReceiptsPage({ empty = "No agent changes recorded yet.", lede }: { empty?: string; lede?: ReactNode }) {
  const { data, error, loading, reload } = useLoad(loadReceipts);
  const [older, setOlder] = useState<ReceiptRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const next = cursor ?? data?.nextCursor ?? null;
  const showOlder = async () => {
    setMore(true);
    setOlderError(null);
    try {
      const page = await callOp<ReceiptPage>("tb.receipts_list", { cursor: next });
      setOlder((o) => [...o, ...page.items]);
      setCursor(page.nextCursor ?? "");
    } catch (e) {
      setOlderError(errorMessage(e));
    } finally {
      setMore(false);
    }
  };
  const rows = data ? [...data.items, ...older] : [];
  return (
    <section className="app-page" aria-label="Receipts">
      <Head title="Receipts" lede={lede} />
      {error ? <LoadError message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : <Loading what="receipts" />
      ) : rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Change</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{when(r.createdAt)}</td>
                  <td>{r.caller.name}</td>
                  <td>{`${r.op}: ${r.summary}`}</td>
                  <td>
                    <Tag status={(RECEIPT_STATUS as Record<string, "live" | "needs-you">)[r.status] ?? "default"}>{r.status}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {olderError ? (
            <Notice tone="needs-you" role="alert">
              {olderError}
            </Notice>
          ) : null}
          {next ? (
            <div>
              <Button variant="quiet" onClick={() => void showOlder()} disabled={more}>
                Show older
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ── Agents & scopes ─────────────────────────────────────────────────────────

const loadAgents = async () => (await callOp<{ agents: Agent[] }>("tb.agents_list", {})).agents;

/**
 * Agents & scopes: the agents connected to this app with their mode. An app with its own scope grid passes `render`
 * (it replaces the default list; the page keeps the heading, loading, error and empty handling) or `children`
 * (shown under the list).
 */
export function AgentsPage({
  empty = "No agents are connected to this app.",
  lede,
  render,
  children,
}: {
  empty?: string;
  lede?: ReactNode;
  render?: (agents: readonly Agent[]) => ReactNode;
  children?: ReactNode;
}) {
  const { data, error, loading, reload } = useLoad(loadAgents);
  return (
    <section className="app-page" aria-label="Agents & scopes">
      <Head title="Agents & scopes" lede={lede} />
      {error ? <LoadError message={error} retrying={loading} onRetry={() => void reload()} /> : null}
      {data === null ? (
        error ? null : <Loading what="agents" />
      ) : data.length === 0 ? (
        <EmptyState title={empty} />
      ) : render ? (
        render(data)
      ) : (
        <div className="ruled">
          {data.map((a) => (
            <div className="item" key={a.id}>
              <Swatch />
              <h3>{a.name}</h3>
              <span className="meta">Connected through Portal</span>
              <div className="side">
                {a.status === "paused" ? <Tag status="needs-you">paused</Tag> : null}
                <Tag>{a.mode}</Tag>
              </div>
            </div>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

// ── Backups & export ────────────────────────────────────────────────────────

/** Backups & export: what the nightly backup holds and the readable copy (`tb.export`) the owner can download. */
export function BackupsPage({ text, lede }: { text: ReactNode; lede?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await tbFetch("tb/v1/ops/tb.export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      const name = /filename="([^"]+)"/u.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "tealbrick-export.tar.gz";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="app-page" aria-label="Backups & export">
      <Head title="Backups & export" lede={lede} />
      <p className="tb-soft">{text}</p>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <div className="tb-ctas">
        <Button onClick={() => void download()} disabled={busy}>
          {busy ? "Preparing the copy" : "Download a copy"}
        </Button>
      </div>
    </section>
  );
}
