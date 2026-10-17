// The app's page router: the template's page paths (standard.tsx) plus `/page/<id>`, the review link the server gives
// agents (`ownerLink("/page/<id>")`). The Page entry in the nav stays on the page that was opened last.
import { useCallback, useEffect, useState } from "react";
import { holdOf, pageOf, standardRoutes } from "./standard.tsx";

/** Shell page id → path under the base `/a/live-artifacts/`. The gallery is the launch page; Agents & scopes is `/configure`. */
export const ROUTES: Record<string, string> = { ...standardRoutes("gallery"), settings: "settings" };
const PAGE_PATH = /^page\/([^/]+)$/;
const OPEN_KEY = "la.openPage";

export interface AppNav {
  /** current page id: gallery, artifact, holds, receipts, agents, settings or backups */
  page: string;
  /** hold id of a `/holds/<id>` deep link, else null */
  hold: string | null;
  /** id of the live page that is open, or the one opened last (the nav's Page entry), else null */
  open: string | null;
  go: (id: string) => void;
  openPage: (id: string) => void;
  /** leave the open page for the gallery and forget it (it was deleted) */
  closePage: () => void;
  href: (id: string) => string;
}

const hrefOfPage = (id: string) => `./page/${encodeURIComponent(id)}`;

function read(): { page: string; hold: string | null; open: string | null } {
  const { pathname } = globalThis.location;
  const base = new URL(document.baseURI).pathname;
  const rest = (pathname.startsWith(base) ? pathname.slice(base.length) : "").replace(/\/+$/, "");
  const m = PAGE_PATH.exec(rest);
  if (m?.[1]) {
    try {
      return { page: "artifact", hold: null, open: decodeURIComponent(m[1]) };
    } catch {
      return { page: "gallery", hold: null, open: null };
    }
  }
  return { page: pageOf(ROUTES, base, pathname, "gallery"), hold: holdOf(pathname), open: null };
}

export function useAppNav(): AppNav {
  const [at, setAt] = useState(read);
  const [last, setLast] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(OPEN_KEY);
    } catch {
      return null;
    }
  });
  const open = at.open ?? last;
  useEffect(() => {
    if (!at.open) return;
    setLast(at.open);
    try {
      sessionStorage.setItem(OPEN_KEY, at.open);
    } catch {
      // storage blocked: the nav entry lasts until reload
    }
  }, [at.open]);
  useEffect(() => {
    const onPop = () => setAt(read());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const hrefOf = useCallback((id: string) => (id === "artifact" && open ? hrefOfPage(open) : `./${ROUTES[id] ?? ""}`), [open]);
  const go = useCallback(
    (id: string) => {
      if (id === "artifact" && !open) return;
      globalThis.history.pushState(null, "", hrefOf(id));
      setAt(read());
    },
    [hrefOf, open],
  );
  const openPage = useCallback((id: string) => {
    globalThis.history.pushState(null, "", hrefOfPage(id));
    setAt(read());
  }, []);
  const closePage = useCallback(() => {
    setLast(null);
    try {
      sessionStorage.removeItem(OPEN_KEY);
    } catch {
      // storage blocked: nothing to forget
    }
    globalThis.history.pushState(null, "", "./");
    setAt(read());
  }, []);
  return { ...at, open, go, openPage, closePage, href: hrefOf };
}
