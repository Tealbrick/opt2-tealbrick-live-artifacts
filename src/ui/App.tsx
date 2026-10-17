// The app inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): header in the app's colour with its
// art, then the pages. Holds, Receipts, Agents & scopes and Backups & export come from ./standard.tsx (the template's
// single copy; pass your own words as props). Add the app's own pages to ROUTES and PAGES, before the standard ones.
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { Gallery } from "./gallery.tsx";
import { LinksPage } from "./links.tsx";
import { useAppNav } from "./nav.ts";
import { ArtifactPage } from "./page.tsx";
import { SettingsPage } from "./settings.tsx";
import { AgentsPage, BackupsPage, HoldsPage, portalHref, ReceiptsPage, useHoldList } from "./standard.tsx";

const NAME = "Live Artifacts";
/** ui 0.3.0 resolves the app id to its header colour (--tb-app-artifacts) and art. */
const COLOUR_ID = "live-artifacts";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Nav order of the mockup: Gallery, Page (only while a page is open), Links, Holds, Receipts, Agents & scopes, Settings, Backups & export.
 *  Paths are in ./nav.ts: the Gallery is the launch page (manifest `ui.launchPath`), Agents & scopes is `ui.configurePath`. */
const standard = (id: string) => STANDARD_PAGES.find((p) => p.id === id) ?? { id, label: id };

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useAppNav();
  const holds = useHoldList();
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState(0);
  const [portal] = useState(portalHref);
  const pages = [
    { id: "gallery", label: "Gallery", badge: review || null },
    ...(nav.open ? [{ id: "artifact", label: "Page" }] : []),
    { id: "links", label: "Links" },
    { ...standard("holds"), badge: holds.holds?.length || null },
    standard("receipts"),
    standard("agents"),
    { id: "settings", label: "Settings" },
    standard("backups"),
  ];
  const signedIn = status === "signed_in" && principal;
  return (
    <AppShell
      title={NAME}
      colour={appColour(COLOUR_ID)}
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
      {!signedIn ? null : nav.page === "artifact" && nav.open ? (
        <ArtifactPage key={nav.open} id={nav.open} onGone={nav.closePage} />
      ) : nav.page === "agents" ? (
        <AgentsPage lede="A gallery holds pages. Each agent has its own gallery and can use the Shared gallery. Reading a page includes its code and the shape of its data, never the values read from your apps." />
      ) : nav.page === "receipts" ? (
        <ReceiptsPage lede="What agents did through Live Artifacts. Inputs are kept only as digests; pages, data and link addresses are never in a receipt." />
      ) : nav.page === "links" ? (
        <LinksPage onOpen={nav.openPage} />
      ) : nav.page === "settings" ? (
        <SettingsPage />
      ) : nav.page === "backups" ? (
        <BackupsPage text="Live Artifacts backs up its data every night to its own volume. The export has pages, versions, data sources and the last data. The list of links holds only fingerprints of the link addresses." />
      ) : nav.page === "holds" ? (
        <HoldsPage list={holds} only={nav.hold} empty="No calls wait for your approval." />
      ) : (
        <Gallery onOpen={nav.openPage} onCounts={setReview} />
      )}
    </AppShell>
  );
}
