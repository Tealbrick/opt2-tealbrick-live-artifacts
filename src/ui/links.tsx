// Links (S4): the Links page (every link of every page), the pieces the page detail and the review use to make and end
// links (the form, the one-time address, the revoke question). Matches the approved mockup (coordination/design/mockups/
// build-app-live-artifacts.ts `links`). Kit components only; the address of a link is shown ONCE, when it is made.
import { Button, CopyBlock, Dialog, EmptyState, Field, Notice, Select, Table, Tag, TextInput, TextLink } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { dateOf, explain, type LinkRow, lifetimeOptions, plural, run, type Version } from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct } from "./common.tsx";

/** "you" for the owner's own link; "Scout, approved by you" for an agent's (an agent link always waits for the owner). */
export const whoMade = (by: { type: string; name: string }): string => (by.type === "person" ? "you" : `${by.name}, approved by you`);

export const LINK_STATUS_TAG: Record<LinkRow["status"], { status: "live" | "idle" | "needs-you"; text: string }> = {
  active: { status: "live", text: "Active" },
  expired: { status: "idle", text: "Ended" },
  revoked: { status: "needs-you", text: "Revoked" },
};

// ── the form: label, lifetime, version ──────────────────────────────────────

export interface LinkForm {
  label: string;
  /** days as a string; null = the owner's setting */
  days: string | null;
  /** "live" follows the live version; else the version number to pin */
  pin: string;
}
export const EMPTY_FORM: LinkForm = { label: "", days: null, pin: "live" };

/** The owner's default lifetime (Settings), read once; 7 days until it is known. */
export function useDefaultDays(): number {
  const [days, setDays] = useState(7);
  useEffect(() => {
    let on = true;
    run("gallery_view", { filter: "archived" })
      .then((out) => on && setDays(out.settings.defaultLinkDays))
      .catch(() => {}); // the form still works with 7; the server uses the real setting when no days are sent
    return () => {
      on = false;
    };
  }, []);
  return days;
}

/** The call input of a form. Lifetime is always sent, so what the owner saw is what the link gets. */
export const formInput = (id: string, f: LinkForm, defaultDays: number) => ({
  id,
  ...(f.label.trim() ? { label: f.label.trim() } : {}),
  expiresInDays: Number(f.days ?? defaultDays),
  ...(f.pin === "live" ? {} : { pin: Number(f.pin) }),
});

export function LinkFormFields({ form, onChange, versions, defaultDays, disabled }: { form: LinkForm; onChange: (f: LinkForm) => void; versions: Version[]; defaultDays: number; disabled: boolean }) {
  const days = form.days ?? String(defaultDays);
  const live = versions.find((v) => v.live)?.n;
  const options = [
    { value: "live", label: live === undefined ? "Follow the live version" : `Follow the live version (now version ${live})` },
    ...versions.map((v) => ({ value: String(v.n), label: `Only version ${v.n}${v.live ? " (live now)" : v.staged ? " (waits for you)" : ""}` })),
  ];
  return (
    <div className="tb-stack">
      <Field label="Label" hint="For you: who gets this link. Up to 40 characters.">
        <TextInput value={form.label} maxLength={40} autoComplete="off" disabled={disabled} onChange={(e) => onChange({ ...form, label: e.target.value })} />
      </Field>
      <Field label="Link lasts" hint="After this the address stops working. A link never lasts longer than 90 days.">
        <Select value={days} options={lifetimeOptions(Number(days))} disabled={disabled} onValueChange={(v) => onChange({ ...form, days: v })} />
      </Field>
      <Field label="Which version" hint="Follow the live version: the link shows every version you make live. Only one version: the link never changes.">
        <Select value={form.pin} options={options} disabled={disabled} onValueChange={(v) => onChange({ ...form, pin: v })} />
      </Field>
    </div>
  );
}

/** The address of a new link, shown once. */
export function CreatedLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  return (
    <div className="tb-stack" role="status">
      <h3>The link is ready</h3>
      <CopyBlock text={url} label="Link address" />
      <p className="tb-soft">Copy it now: the app shows it only once. The list of links keeps a fingerprint, not the address. For 24 hours the app also keeps the answer to this request sealed, so a repeated request gets the same address. The link works until {dateOf(expiresAt)}. You can revoke it at any time.</p>
    </div>
  );
}

// ── revoke ──────────────────────────────────────────────────────────────────

/** "Revoke this link?" with the plain consequence; the call is the caller's (it knows what to read again). */
export function RevokeDialog({ link, busy, error, onClose, onRevoke }: { link: { label: string } | null; busy: boolean; error: string | null; onClose: () => void; onRevoke: () => void }) {
  return (
    <Dialog
      open={link !== null}
      title="Revoke this link?"
      kicker={link?.label || "Link"}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep
          </Button>
          <Button variant="danger" confirm onClick={onRevoke} disabled={busy}>
            Revoke the link
          </Button>
        </>
      }
    >
      <Failure message={error} />
      <p className="tb-soft">People who have this link can no longer open the page. It takes effect at once. You cannot undo it, but you can make a new link.</p>
    </Dialog>
  );
}

// ── the Links page ──────────────────────────────────────────────────────────

export function LinksPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ items: LinkRow[]; active: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<LinkRow | null>(null);
  const { busy, error, setError, act } = useAct();
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const out = await run("links_list", {});
      if (mine !== seq.current) return;
      setData(out);
      setLoadError(null);
    } catch (e) {
      if (mine === seq.current) setLoadError(explain(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = (l: LinkRow) =>
    act(async () => {
      try {
        await run("link_revoke", { linkId: l.id });
        setRevoking(null);
      } finally {
        await load(); // also after a failure: show what is true now
      }
    });

  return (
    <section className="app-page" aria-label="Links">
      <PageHead
        title="Links"
        lede="Every viewer link of every page. A link is a secret address. Anyone who has it can open the page until it ends or you revoke it. The app keeps counts only, no names or addresses."
      />
      {revoking ? null : <Failure message={error} />}
      {loadError ? <LoadFailed message={loadError} retrying={loading} onRetry={() => void load()} /> : null}
      {data === null ? (
        loadError ? null : (
          <p className="tb-soft" role="status">
            Loading the links.
          </p>
        )
      ) : data.items.length === 0 ? (
        <EmptyState title="No links yet">Open a page and press Create link to share it. When an agent asks for a link, you approve it in Holds first.</EmptyState>
      ) : (
        <>
          <p className="tb-soft">{plural(data.active, "link")} active.</p>
          <Table aria-label="All links">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Label</th>
                  <th>Created by</th>
                  <th>Ends</th>
                  <th>Views</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id}>
                    <td className="strong">
                      <TextLink
                        href={`./page/${encodeURIComponent(l.artifactId)}`}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab / window: let the link work
                          e.preventDefault();
                          onOpen(l.artifactId);
                        }}
                      >
                        {l.artifactTitle}
                      </TextLink>
                    </td>
                    <td>{l.label || "No label"}</td>
                    <td>{whoMade(l.createdBy)}</td>
                    <td>{dateOf(l.expiresAt)}</td>
                    <td className="num">{l.views}</td>
                    <td>
                      <Tag status={LINK_STATUS_TAG[l.status].status}>{LINK_STATUS_TAG[l.status].text}</Tag>
                    </td>
                    <td>
                      {l.status === "active" ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setError(null);
                            setRevoking(l);
                          }}
                          disabled={busy}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
          </Table>
          {data.items.length >= 200 ? <Notice tone="neutral">The newest 200 links are shown.</Notice> : null}
        </>
      )}
      <RevokeDialog link={revoking} busy={busy} error={error} onClose={() => setRevoking(null)} onRevoke={() => revoking && void revoke(revoking)} />
    </section>
  );
}
