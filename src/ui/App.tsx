// The app inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): header in the app's colour with its
// art, then the pages. Holds, Receipts, Agents & scopes and Backups & export come from ./standard.tsx (the template's
// single copy; pass your own words as props). Add the app's own pages to ROUTES and PAGES, before the standard ones.
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { AgentsPage, BackupsPage, HoldsPage, portalHref, ReceiptsPage, standardRoutes, useHoldList, useNav } from "./standard.tsx";

const NAME = "Live Artifacts";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/live-artifacts/`. Holds is the launch page (manifest `ui.launchPath`), Agents & scopes is `ui.configurePath`. */
const ROUTES = standardRoutes();
const PAGES = STANDARD_PAGES.filter((p) => p.id in ROUTES);

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "holds");
  const holds = useHoldList();
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p));
  const signedIn = status === "signed_in" && principal;
  return (
    <AppShell
      title={NAME}
      colour={appColour("live-artifacts")}
      art={appArt("live-artifacts", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "agents" ? (
        <AgentsPage />
      ) : nav.page === "receipts" ? (
        <ReceiptsPage />
      ) : nav.page === "backups" ? (
        <BackupsPage text="A backup of everything in this app runs every night inside your deployment. The export is a readable copy you can keep." />
      ) : (
        <HoldsPage list={holds} only={nav.hold} empty="No calls wait for your approval." />
      )}
    </AppShell>
  );
}
