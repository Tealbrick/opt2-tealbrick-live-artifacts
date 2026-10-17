// Page (id "artifact", path /page/<id>): the preview, the review of what the page may show, its data sources, schedule,
// links and versions. Matches the approved mockup (coordination/design/mockups/build-app-live-artifacts.ts).
// There is no owner "Refresh now" op. Links (S4): the Links box lists the page's links, with Create link and Revoke; step 3
// of the review makes a link too. The address of a new link is shown once.
import { appName, Button, Dialog, Field, Notice, StepFlow, Swatch, Switch, Table, Tag, TextInput, TextLink } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { RUNS_NO_SCRIPTS_SENTENCE, RUNS_SCRIPTS_SENTENCE } from "../scripts-text.ts";
import {
  type ArtifactInfo,
  ago,
  type Detail,
  dateOf,
  everyLabel,
  explain,
  type Link,
  type Out,
  plural,
  run,
  type Source,
  safeHref,
  sourceSentence,
  stamp,
  until,
  type Version,
  VIEWER_MISSING,
} from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct } from "./common.tsx";
import { PageTags } from "./gallery.tsx";
import { CreatedLink, EMPTY_FORM, formInput, LINK_STATUS_TAG, type LinkForm, LinkFormFields, RevokeDialog, useDefaultDays } from "./links.tsx";

type Ticket = { kind: "loading" } | { kind: "ok"; url: string; version: number } | { kind: "missing" } | { kind: "error"; message: string };
type TestOut = Out<"source_test"> | { error: string };

const KIB = 1024;

// ── data sources ────────────────────────────────────────────────────────────

function sourceTag(s: Source) {
  if (s.kind === "push") return <Tag>Pushed by an agent</Tag>;
  if (!s.approved) return <Tag status="needs-you">Waits for you</Tag>;
  if (s.status === "error") return <Tag status="needs-you">Read failed</Tag>;
  if (s.status === "held") return <Tag status="busy">Held for approval</Tag>;
  if (s.status === "paused") return <Tag status="idle">Paused</Tag>;
  return <Tag status="live">Approved</Tag>;
}

const cell = (v: unknown): string => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return (t ?? "").length > 60 ? `${(t ?? "").slice(0, 57)}…` : (t ?? "");
};

/** Sample rows of a test read: a small table for a list of flat objects, else one line per value. */
function Sample({ sample }: { sample: unknown }) {
  const rows = Array.isArray(sample) ? sample.slice(0, 5) : [];
  const first = rows[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const cols = Object.keys(first as Record<string, unknown>).slice(0, 6);
    return (
      <div className="scroll-x">
        <Table aria-label="Sample rows">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: sample rows have no id; the list is static
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{cell((r as Record<string, unknown>)[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  }
  return <pre className="view">{cell(sample)}</pre>;
}

function TestResult({ s, result }: { s: Source; result: TestOut }) {
  if ("error" in result) return <Failure message={result.error} />;
  const app = s.product ? appName(s.product) : "The other app";
  switch (result.status) {
    case "ok":
      return (
        <div className="tb-stack" role="status">
          <p className="tb-soft">{result.rows === null ? "The read worked." : `The read worked. It gave ${plural(result.rows, "row")}${result.rows > 5 ? "; the first 5 are shown" : ""}.`}</p>
          <Sample sample={result.sample} />
        </div>
      );
    case "held":
      return (
        <Notice tone="neutral" role="status">
          This read waits for your approval in Holds.
        </Notice>
      );
    case "paused":
      return (
        <Notice tone="neutral" role="status">
          {app} is switched off for now.
        </Notice>
      );
    case "not_read":
      return (
        <Notice tone="neutral" role="status">
          Your agent fills this source. There is nothing to read.
        </Notice>
      );
    default: {
      const href = safeHref(result.configureLink);
      return (
        <Notice tone="needs-you" role="alert">
          {result.code === "scope_denied" ? `${app} does not share this data with Live Artifacts yet.` : result.code === "projection_empty" ? "The read worked, but none of the fields you keep were in it." : "The read failed. Try again in a moment."}{" "}
          {href ? <TextLink href={href}>{`Share it in ${app}`}</TextLink> : null}
        </Notice>
      );
    }
  }
}

// ── page ────────────────────────────────────────────────────────────────────

export function ArtifactPage({ id, onGone }: { id: string; onGone: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ticket, setTicket] = useState<Ticket>({ kind: "loading" });
  const [previewVersion, setPreviewVersion] = useState<number | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [tests, setTests] = useState<Record<string, TestOut>>({});
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  // links: the form (shared by the dialog and step 3), the address of a link just made (shown once), the link to revoke
  const [linking, setLinking] = useState(false);
  const [form, setForm] = useState<LinkForm>(EMPTY_FORM);
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<Link | null>(null);
  const defaultDays = useDefaultDays();
  const { busy, error, setError, act } = useAct();
  const seq = useRef(0);
  const ticketSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const out = await run("artifact_detail", { id });
      if (mine !== seq.current) return;
      setDetail(out);
      setLoadError(null);
    } catch (e) {
      if (mine === seq.current) setLoadError(explain(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [id]);

  const loadTicket = useCallback(
    async (version?: number) => {
      const mine = ++ticketSeq.current;
      setTicket({ kind: "loading" });
      try {
        const out = await run("artifact_preview_ticket", version === undefined ? { id } : { id, version });
        if (mine === ticketSeq.current) setTicket({ kind: "ok", url: out.url, version: out.version });
      } catch (e) {
        if (mine !== ticketSeq.current) return;
        setTicket((e as { code?: unknown } | null)?.code === "view_origin_missing" ? { kind: "missing" } : { kind: "error", message: explain(e) });
      }
    },
    [id],
  );

  useEffect(() => {
    setDetail(null);
    setTests({});
    setDrafts({});
    setPreviewVersion(undefined);
    setForm(EMPTY_FORM);
    setCreated(null);
    setError(null);
    void load();
    void loadTicket();
  }, [load, loadTicket, setError]);

  /** A change: run it, then read the page again (also after a failure, so the screen shows what is true now). */
  const change = (fn: () => Promise<unknown>, after?: () => void) =>
    act(async () => {
      try {
        await fn();
        after?.();
      } finally {
        await load();
      }
    });

  if (!detail) {
    return (
      <section className="app-page" aria-label="Page">
        <PageHead title="Page" />
        {loadError ? <LoadFailed message={loadError} retrying={loading} onRetry={() => void load()} /> : <p className="tb-soft" role="status">Loading the page.</p>}
      </section>
    );
  }

  const a = detail.artifact as unknown as ArtifactInfo;
  const archived = a.status === "archived";
  const reads = detail.sources.filter((s) => s.kind === "read");
  const oldest = detail.versions[detail.versions.length - 1];
  const lastData = detail.sources.map((s) => s.fetchedAt).filter((t): t is string => t !== null).sort().pop();
  const staged = detail.versions.find((v) => v.staged);

  const approve = (s: Source, viewers: boolean) => change(() => run("source_approve", { id, key: s.key, digest: s.digest, viewers }), () => setDrafts((d) => ({ ...d, [s.key]: false })));
  const revoke = (s: Source) => change(() => run("source_revoke", { id, key: s.key }));
  const test = (s: Source) =>
    act(async () => {
      try {
        const out = await run("source_test", { id, key: s.key });
        setTests((t) => ({ ...t, [s.key]: out }));
      } catch (e) {
        setTests((t) => ({ ...t, [s.key]: { error: explain(e) } }));
      }
    });
  const schedule = (everySeconds: number | null) => change(() => run("trigger_approve", { id, everySeconds }));
  const makeLive = (v: Version) =>
    change(
      () => run("publish_version", { id, version: v.n }),
      () => {
        setPreviewVersion(undefined);
        void loadTicket();
      },
    );
  const preview = (v: number | undefined) => {
    setPreviewVersion(v);
    void loadTicket(v);
  };
  const makeLink = () =>
    change(async () => {
      const out = await run("link_create", formInput(id, form, defaultDays, detail.runsScripts === true));
      setCreated({ url: out.url, expiresAt: out.expiresAt });
    });
  const revokeLink = (l: Link) =>
    change(
      () => run("link_revoke", { linkId: l.id }),
      () => setRevoking(null),
    );
  const closeLinking = () => {
    setLinking(false);
    setCreated(null);
  };
  const viewersOf = (s: Source) => (s.approved ? s.viewers : (drafts[s.key] ?? false));
  const setViewers = (s: Source, on: boolean) => (s.approved ? void approve(s, on) : setDrafts((d) => ({ ...d, [s.key]: on })));
  const waits = [
    reads.some((s) => !s.approved) ? `${plural(reads.filter((s) => !s.approved).length, "data source")} wait for you.` : null,
    a.refresh.state === "waiting_approval" ? "A refresh schedule waits for you." : null,
    staged ? `Version ${staged.n} waits for you.` : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="app-page" aria-label="Page">
      <PageHead
        title={a.title}
        tags={<PageTags a={a} />}
        lede={`Made by ${a.createdBy.name} on ${dateOf(String((a as { createdAt?: string }).createdAt ?? oldest?.createdAt ?? ""))}. Version ${a.liveVersion} is live.${lastData ? ` Data was updated ${ago(lastData)}.` : ""}`}
      >
        <div className="tb-ctas">
          <Button onClick={() => void change(() => run("artifact_archive", { id, archived: !archived }))} disabled={busy}>
            {archived ? "Restore" : "Archive"}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setTyped("");
              setError(null);
              setDeleting(true);
            }}
            disabled={busy}
          >
            Delete
          </Button>
        </div>
      </PageHead>
      {a.description ? <p className="tb-soft la-desc">{a.description}</p> : null}
      {reviewing || deleting || linking || revoking ? null : <Failure message={error} />}
      {loadError ? <LoadFailed message={loadError} retrying={loading} onRetry={() => void load()} /> : null}
      <div className="split">
        <div className="tb-stack">
          <div className="vshell">
            <div className="vbanner">
              <span>
                <strong>{a.title}</strong> · preview of version {ticket.kind === "ok" ? ticket.version : (previewVersion ?? a.liveVersion)} · only you see this
              </span>
              {previewVersion !== undefined ? (
                <Button size="sm" onClick={() => preview(undefined)}>
                  Show the live version
                </Button>
              ) : null}
            </div>
            <div className="sandbox la-sandbox">
              {/* The frame shows OUR viewer shell on the separate views origin (no cookies there). The shell needs
                  allow-same-origin to load its own assets (CORP same-origin); the agent page inside it is sandboxed
                  again by the shell and by its CSP (S2 review, finding 2). */}
              {ticket.kind === "ok" && safeHref(ticket.url) ? (
                <iframe
                  className="la-frame"
                  title={`Preview of ${a.title}`}
                  sandbox="allow-scripts allow-same-origin"
                  referrerPolicy="no-referrer"
                  src={safeHref(ticket.url) ?? undefined}
                />
              ) : ticket.kind === "loading" ? (
                <p className="tb-soft" role="status">
                  Loading the preview.
                </p>
              ) : ticket.kind === "missing" ? (
                <Notice tone="neutral" role="status">
                  {VIEWER_MISSING}
                </Notice>
              ) : (
                <Notice tone="needs-you" role="alert">
                  <span className="tb-row">
                    <span>{ticket.kind === "error" ? ticket.message : "The preview did not open."}</span>
                    <Button size="sm" onClick={() => void loadTicket(previewVersion)}>
                      Try again
                    </Button>
                  </span>
                </Notice>
              )}
            </div>
            <p className="meta">Never enter a password on a shared page. In some browsers a page can send what it shows to outside sites, so do not type private information into it.</p>
          </div>
          <section className="tb-card la-review" aria-label="Review and share">
            <h2>Review and share</h2>
            <p className="tb-soft">{waits.length > 0 ? waits.join(" ") : "Nothing waits for you. Check what data the page may show before anyone else sees it."}</p>
            <div className="tb-ctas">
              <Button variant="primary" onClick={() => setReviewing(true)} disabled={archived}>
                Review and share
              </Button>
            </div>
          </section>
        </div>
        <aside className="tb-stack">
          <section className="tb-stack" aria-label="Data sources">
            <h2>Data sources</h2>
            {detail.sources.length === 0 ? (
              <p className="tb-soft">This page reads no data.</p>
            ) : (
              <div className="ruled">
                {detail.sources.map((s) => (
                  <div className="item" key={s.key}>
                    <Swatch />
                    <h3>
                      {s.label} {sourceTag(s)}
                    </h3>
                    <p>{sourceSentence(s, a.refresh.everySeconds)}</p>
                    <span className="meta">
                      Shown to people with a link: <b>{s.viewers && s.approved ? "yes" : "no"}</b>
                      {s.fetchedAt ? ` · last data ${ago(s.fetchedAt)}` : ""}
                    </span>
                    {s.kind === "read" ? (
                      <div className="side">
                        <Button size="sm" onClick={() => void test(s)} disabled={busy}>
                          Test read
                        </Button>
                        {s.approved ? (
                          <Button size="sm" variant="danger" onClick={() => void revoke(s)} disabled={busy}>
                            Revoke
                          </Button>
                        ) : (
                          <Button size="sm" variant="primary" onClick={() => void approve(s, viewersOf(s))} disabled={busy}>
                            Approve
                          </Button>
                        )}
                      </div>
                    ) : null}
                    {tests[s.key] ? (
                      <div className="la-test">
                        <TestResult s={s} result={tests[s.key] as TestOut} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="tb-stack" aria-label="Schedule">
            <h2>Schedule</h2>
            <ScheduleBox a={a} busy={busy} onSet={(n) => void schedule(n)} />
          </section>
          <section className="tb-stack" aria-label="Links">
            <h2>Links</h2>
            {detail.links.length === 0 ? (
              <p className="tb-soft">No links. Nobody but you can open this page.</p>
            ) : (
              <div className="ruled">
                {detail.links.map((l) => (
                  <LinkItem
                    key={l.id}
                    l={l}
                    busy={busy}
                    onRevoke={() => {
                      setError(null);
                      setRevoking(l);
                    }}
                  />
                ))}
              </div>
            )}
            <div className="tb-ctas">
              <Button
                size="sm"
                onClick={() => {
                  setError(null);
                  setForm(EMPTY_FORM);
                  setCreated(null);
                  setLinking(true);
                }}
                disabled={busy || archived}
              >
                Create link
              </Button>
            </div>
          </section>
          <section className="tb-stack" aria-label="Versions">
            <h2>Versions</h2>
            <div className="ruled">
              {detail.versions.map((v) => (
                <div className="item" key={v.n}>
                  <Swatch className={v.staged ? "is-needs-you" : undefined} />
                  <h3>
                    Version {v.n} {v.live ? <Tag status="live">live</Tag> : null}
                    {v.staged ? <Tag status="busy">waits for you</Tag> : null}
                  </h3>
                  <p>
                    {v.createdBy.name} · {stamp(v.createdAt)}
                    {v.note ? ` · ${v.note}` : ""}
                  </p>
                  {v.live ? null : (
                    <div className="side">
                      <Button size="sm" onClick={() => preview(v.n)} disabled={busy || previewVersion === v.n}>
                        Preview
                      </Button>
                      <Button size="sm" variant={v.staged ? "primary" : "secondary"} onClick={() => void makeLive(v)} disabled={busy || archived}>
                        Make live
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
          <Switch
            label="Let agents change this shared page without asking"
            checked={a.autoPublish === "agent"}
            disabled={busy}
            onCheckedChange={(on) => void change(() => run("autopublish_set", { id, mode: on ? "agent" : "owner" }))}
          />
          <p className="tb-hint">Off: a new version or new numbers from an agent wait here until you or a held approval make them live. On: an agent can also put a different page that runs scripts under a link that already allows scripts.</p>
        </aside>
      </div>

      <StepFlow
        open={reviewing}
        title="Review and share"
        kicker={a.title}
        size="lg"
        busy={busy}
        onClose={() => {
          setReviewing(false);
          setCreated(null);
        }}
        onFinish={() => {
          setReviewing(false);
          setCreated(null);
        }}
        steps={[
          {
            name: "Page",
            render: () => (
              <div className="tb-stack">
                <h3>What does this page contain?</h3>
                <p className="tb-soft">
                  Version {detail.version.n} is live: {Math.max(1, Math.round(detail.version.bytes / KIB))} KiB, written by {detail.version.createdBy.name} on {stamp(detail.version.createdAt)}. The preview on the page shows it as a viewer would see it.
                </p>
                <p className="tb-soft">{detail.runsScripts ? RUNS_SCRIPTS_SENTENCE : RUNS_NO_SCRIPTS_SENTENCE} The page cannot read your Tealbrick data or session. A viewer can still copy what is on screen.</p>
                {detail.lint.length > 0 ? (
                  <ul className="tb-list">
                    {detail.lint.map((l) => (
                      <li key={l.code}>{l.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="tb-soft">The page check found nothing to note.</p>
                )}
                {staged ? <Notice tone="neutral">Version {staged.n} waits for you. Make it live in the Versions box after you looked at it.</Notice> : null}
                {ticket.kind === "missing" ? <Notice tone="neutral">{VIEWER_MISSING}</Notice> : null}
              </div>
            ),
          },
          {
            name: "Data",
            render: () => (
              <div className="tb-stack">
                <Failure message={error} />
                <h3>What data may this page show?</h3>
                <p className="tb-soft">Page code written by an agent can see this data in the viewer’s browser. In some browsers page code can send what the page shows to outside sites, so only show data you are happy for a viewer to copy.</p>
                {detail.sources.length === 0 ? <p className="tb-soft">This page has no data sources.</p> : null}
                <div className="la-checks">
                  {detail.sources.map((s) => (
                    <div className="la-source" key={s.key}>
                      <h4>
                        {s.label} {sourceTag(s)}
                      </h4>
                      <p className="tb-soft">{sourceSentence(s, a.refresh.everySeconds)}</p>
                      <Switch label="Show to people with a link" checked={viewersOf(s)} disabled={busy} onCheckedChange={(on) => setViewers(s, on)} />
                      <p className="tb-hint">Off: only you see these rows in the app. On: everyone with a link sees them.</p>
                      {s.approved ? null : (
                        <div className="tb-ctas">
                          <Button size="sm" variant="primary" onClick={() => void approve(s, viewersOf(s))} disabled={busy}>
                            Use in this page
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {a.refresh.state === "waiting_approval" && a.refresh.everySeconds ? (
                  <div className="la-source">
                    <h4>Refresh schedule</h4>
                    <p className="tb-soft">The page asks to read its data again every {everyLabel(a.refresh.everySeconds)}.</p>
                    <div className="tb-ctas">
                      <Button size="sm" variant="primary" onClick={() => void schedule(a.refresh.everySeconds)} disabled={busy}>
                        {`Refresh every ${everyLabel(a.refresh.everySeconds)}`}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            name: "Link",
            optional: "Finish without a link",
            nextLabel: created ? "Done" : "Create link",
            canNext: created !== null || (ticket.kind !== "missing" && !archived),
            onNext: async () => {
              if (created) return true;
              await makeLink(); // stays on the step: the address is shown once, then Done
              return false;
            },
            render: () => (
              <div className="tb-stack">
                <h3>Who may open this page?</h3>
                <p className="tb-soft">
                  Today only you can open it, in this app. A link gives other people a view of the page without an account. Anyone who has the address can open it until it ends or you revoke it. The app keeps counts only, no names or addresses.
                </p>
                <Failure message={error} />
                {ticket.kind === "missing" ? <Notice tone="neutral">{VIEWER_MISSING}</Notice> : null}
                {created ? (
                  <CreatedLink url={created.url} expiresAt={created.expiresAt} />
                ) : (
                  <>
                    <LinkFormFields form={form} onChange={setForm} versions={detail.versions} defaultDays={defaultDays} disabled={busy} />
                    <Notice tone="neutral">
                      <span className="tb-stack">
                        <b>What a link cannot promise</b>
                        <ul className="la-advice">
                          <li>{detail.runsScripts ? RUNS_SCRIPTS_SENTENCE : `${RUNS_NO_SCRIPTS_SENTENCE} If a later version gains scripts, this link still shows it without scripts.`}</li>
                          <li>The page cannot read your Tealbrick data or session. In some browsers page code can send what the page shows, and what a viewer types, to outside sites. Do not type private information into a page. Outside files in the page markup are removed before it is shown.</li>
                          <li>Everything the page shows can be copied by whoever sees it.</li>
                          <li>A new version or new numbers from an agent wait for you before link holders see them. You can switch that off on the page.</li>
                        </ul>
                      </span>
                    </Notice>
                    <p className="tb-hint">{`${plural(detail.links.filter((l) => l.status === "active").length, "link")} of this page ${detail.links.filter((l) => l.status === "active").length === 1 ? "is" : "are"} active. At most 5.`}</p>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      <Dialog
        open={linking}
        title="Create a link"
        kicker={a.title}
        busy={busy}
        onClose={closeLinking}
        footer={
          created ? (
            <Button variant="primary" onClick={closeLinking}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={closeLinking} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" confirm onClick={() => void makeLink()} disabled={busy || ticket.kind === "missing"}>
                Create link
              </Button>
            </>
          )
        }
      >
        <Failure message={error} />
        {ticket.kind === "missing" ? <Notice tone="neutral">{VIEWER_MISSING}</Notice> : null}
        {created ? (
          <CreatedLink url={created.url} expiresAt={created.expiresAt} />
        ) : (
          <>
            <p className="tb-soft">Anyone who has the address can open this page without an account until the link ends or you revoke it.</p>
            <LinkFormFields form={form} onChange={setForm} versions={detail.versions} defaultDays={defaultDays} disabled={busy} />
          </>
        )}
      </Dialog>

      <RevokeDialog link={revoking} busy={busy} error={error} onClose={() => setRevoking(null)} onRevoke={() => revoking && void revokeLink(revoking)} />

      <Dialog
        open={deleting}
        title="Delete this page?"
        kicker={a.title}
        busy={busy}
        onClose={() => setDeleting(false)}
        footer={
          <>
            <Button onClick={() => setDeleting(false)} disabled={busy}>
              Keep
            </Button>
            <Button
              variant="danger"
              confirm
              disabled={busy || typed.trim().toLowerCase() !== "delete"}
              onClick={() =>
                void act(async () => {
                  await run("artifact_remove", { id });
                  setDeleting(false);
                  onGone();
                })
              }
            >
              Delete the page
            </Button>
          </>
        }
      >
        <Failure message={error} />
        <p className="tb-soft">
          This deletes the page with all its versions, its data and its links. Links stop working at once. You cannot undo it.
        </p>
        <Field label="Type delete to confirm">
          <TextInput value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </Dialog>
    </section>
  );
}

function ScheduleBox({ a, busy, onSet }: { a: ArtifactInfo; busy: boolean; onSet: (everySeconds: number | null) => void }) {
  const r = a.refresh;
  const every = r.everySeconds;
  const off = (
    <Button size="sm" onClick={() => onSet(null)} disabled={busy}>
      Switch off
    </Button>
  );
  let tag: ReactNode;
  let text: string;
  let buttons: ReactNode = null;
  switch (r.state) {
    case "waiting_approval":
      tag = <Tag status="needs-you">Waits for you</Tag>;
      text = every ? `The page asks to refresh every ${everyLabel(every)}.` : "The page asks to refresh.";
      buttons = every ? (
        <Button size="sm" variant="primary" onClick={() => onSet(every)} disabled={busy}>
          Approve
        </Button>
      ) : null;
      break;
    case "on":
      tag = <Tag status="live">On</Tag>;
      text = `Refreshes every ${every ? everyLabel(every) : "while"}.${r.lastAt ? ` Last: ${ago(r.lastAt)}.` : ""}${r.nextAt ? ` Next: ${until(r.nextAt)}.` : ""}`;
      buttons = off;
      break;
    case "paused_error":
      tag = <Tag status="needs-you">Refresh paused</Tag>;
      text = `The page stopped refreshing after repeated failures.${r.lastAt ? ` It shows data from ${ago(r.lastAt)}.` : ""}`;
      buttons = (
        <>
          {every ? (
            <Button size="sm" variant="primary" onClick={() => onSet(every)} disabled={busy}>
              Resume refresh
            </Button>
          ) : null}
          {off}
        </>
      );
      break;
    case "paused":
      tag = <Tag status="idle">On hold</Tag>;
      text = "Refresh is on hold. It continues by itself when the hold ends.";
      buttons = off;
      break;
    default:
      tag = <Tag status="idle">Off</Tag>;
      text = every ? `The page does not refresh. It did every ${everyLabel(every)}.` : "The page does not refresh. It shows the data as it is.";
      buttons = every ? (
        <Button size="sm" onClick={() => onSet(every)} disabled={busy}>
          Switch on
        </Button>
      ) : null;
  }
  return (
    <div className="tb-stack la-schedule">
      <div className="tb-row">{tag}</div>
      <p className="tb-soft">{text}</p>
      {buttons ? <div className="tb-ctas">{buttons}</div> : null}
    </div>
  );
}

function LinkItem({ l, busy, onRevoke }: { l: Link; busy: boolean; onRevoke: () => void }) {
  const tag = LINK_STATUS_TAG[l.status];
  return (
    <div className="item">
      <Swatch />
      <h3>
        {l.label || "No label"} {l.status === "active" ? null : <Tag status={tag.status}>{tag.text}</Tag>}{" "}
        {l.runsScripts ? (
          <Tag status="needs-you" title={RUNS_SCRIPTS_SENTENCE}>
            Runs scripts
          </Tag>
        ) : null}
      </h3>
      <p>
        Ends {dateOf(l.expiresAt)} · {l.pinVersion === null ? "latest version" : `pinned to version ${l.pinVersion}`}
      </p>
      <span className="meta">
        {plural(l.views, "view")}
        {l.lastSeenDay ? ` · last viewed ${dateOf(l.lastSeenDay)}` : ""}
      </span>
      {l.status === "active" ? (
        <div className="side">
          <Button size="sm" variant="danger" onClick={onRevoke} disabled={busy}>
            Revoke
          </Button>
        </div>
      ) : null}
    </div>
  );
}
