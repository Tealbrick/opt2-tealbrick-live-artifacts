// Typed person-op calls for the owner UI (op ids and I/O types from the generated kit; types only, erased at build),
// plain sentences for failures (L18) and the small formatters the pages share.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { appName } from "@opt2-tealbrick/ui";
import type { PersonOps } from "#kit";
import { errorMessage } from "./standard.tsx";

export type In<K extends keyof PersonOps> = PersonOps[K]["input"];
export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];
export type GalleryData = Out<"gallery_view">;
export type Summary = GalleryData["items"][number];
export type Filter = NonNullable<In<"gallery_view">["filter"]>;
export type Detail = Out<"artifact_detail">;
/** `artifact_detail.artifact` is an open object in the kit; the server returns the summary plus these three fields. */
export type ArtifactInfo = Summary & { autoPublish: "owner" | "agent"; origin: { kind: string; ref: string | null }; forkedFrom: string | null };
export type Source = Detail["sources"][number];
export type Version = Detail["versions"][number];
export type Link = Detail["links"][number];
export type LinkRow = Out<"links_list">["items"][number];
export type Refresh = Summary["refresh"];

export function run<K extends keyof PersonOps>(op: K, input: In<K>): Promise<Out<K>> {
  return callOp<Out<K>>(op, input as never);
}

/** Largest page the server takes (src/limits.ts htmlBytes), for a check before the file is sent. */
export const HTML_MAX_BYTES = 256 * 1024;

/** Plain sentence for a failed call: the cause and what to do, never raw JSON or upstream text (L18). */
export function explain(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  switch (err.code) {
    case "not_found":
      return "That page is gone. Go back to the gallery and try again.";
    case "digest_changed":
      return "This source changed. Look at it again.";
    case "source_unknown":
      return "That data source is gone. Reload the page and look again.";
    case "view_lint_failed":
      return `The page was refused. ${typeof err.message === "string" ? err.message : "Its code breaks a rule."}`;
    case "version_unknown":
      return "That version is gone. Old versions are removed after a while. Reload the page.";
    case "artifact_archived":
      return "This page is archived. Restore it first.";
    case "html_too_large":
      return "The page is larger than 256 KiB. Make the file smaller.";
    case "limit_reached":
      return "This app holds no more pages. Delete one first.";
    case "gallery_not_found":
      return "That gallery is gone. Reload and try again.";
    case "view_origin_missing":
      return VIEWER_MISSING;
    case "links_limit_artifact":
      return "This page has 5 active links. Revoke one first.";
    case "links_limit_workspace":
      return "The workspace has 50 active links. Revoke one first.";
    case "link_not_found":
      return "That link is gone. Reload the page and look again.";
    case "invalid_input":
      return "Check the fields and try again.";
    default:
      return errorMessage(e);
  }
}

/** The normal state until the bridge has a viewer address (LA-1). */
export const VIEWER_MISSING = "Links and previews need the viewer address. Ask Portal to redeploy the bridge.";

/** Lifetimes the owner can pick for a link, in days (a link never lasts longer than 90). */
export const LINK_DAYS = [1, 7, 30, 90];
export const daysLabel = (d: number): string => (d === 1 ? "1 day" : d === 90 ? "90 days (longest)" : `${d} days`);
/** The lifetimes to offer: the standard ones plus the owner's own setting when it is another number. */
export const lifetimeOptions = (current: number | null): { value: string; label: string }[] =>
  (current !== null && !LINK_DAYS.includes(current) ? [...LINK_DAYS, current].sort((a, b) => a - b) : LINK_DAYS).map((d) => ({ value: String(d), label: daysLabel(d) }));

// ── time ────────────────────────────────────────────────────────────────────

const LOCALE = "en-GB";
/** "9 Oct 2026" (en-GB, the same for everyone). */
export function dateOf(isoTime: string): string {
  return new Date(isoTime).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
}
/** "14 Oct 08:40" (the mockup's version time). */
export function stamp(isoTime: string): string {
  const d = new Date(isoTime);
  return `${d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}
/** "4 min ago", "3 h ago", else the date. */
export function ago(isoTime: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(isoTime).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return dateOf(isoTime);
}
/** "in 12 min", "in 3 h", else the date; "soon" when it is due now. */
export function until(isoTime: string, now: number = Date.now()): string {
  const s = Math.round((new Date(isoTime).getTime() - now) / 1000);
  if (s < 45) return "soon";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86_400) return `in ${Math.round(s / 3600)} h`;
  return dateOf(isoTime);
}
/** "15 min", "1 h", "2 days" for a refresh interval in seconds. */
export function everyLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "1 day" : `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

// ── words for what the server says ──────────────────────────────────────────

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a card or the page header says about the refresh, in one phrase. */
export function refreshPhrase(r: Refresh): string {
  switch (r.state) {
    case "on":
      return r.everySeconds ? `every ${everyLabel(r.everySeconds)}` : "refreshing";
    case "waiting_approval":
      return "not refreshing yet";
    case "paused_error":
      return "refresh stopped";
    case "paused":
      return "refresh on hold";
    default:
      return "no refresh";
  }
}

/** The source's own sentence: product · op · input · fields kept · row limit. A pushed source says who fills it. */
export function sourceSentence(s: Source, everySeconds: number | null): string {
  if (s.kind === "push") return "Data your agent pushes to this page.";
  const parts: string[] = [`${s.product ? appName(s.product) : "Another app"} · ${s.op ?? "a read"}`];
  const input = s.input && typeof s.input === "object" ? Object.entries(s.input) : [];
  if (input.length > 0) parts.push(input.map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", "));
  if (everySeconds) parts.push(`every ${everyLabel(everySeconds)}`);
  const p = (s.projection ?? {}) as { pick?: unknown; limit?: unknown };
  if (Array.isArray(p.pick) && p.pick.length > 0) parts.push(p.pick.length > 4 ? `keeps ${p.pick.length} fields` : `keeps ${p.pick.join(", ")}`);
  if (typeof p.limit === "number") parts.push(`up to ${p.limit} rows`);
  return parts.join(" · ");
}

/** A link the server gave us is opened only when it is http(s). */
export const safeHref = (url: string | null): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url, globalThis.location?.href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};
