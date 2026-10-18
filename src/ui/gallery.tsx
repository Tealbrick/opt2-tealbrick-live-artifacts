// Gallery (launch page): the pages the agents made, as cards, with the filter chips, the notices the server raises and
// "Add a page by hand". Matches the approved mockup (coordination/design/mockups/build-app-live-artifacts.ts).
import { Button, ButtonLink, Chip, ChipGroup, Dialog, EmptyState, Field, Notice, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ArtifactInfo, ago, explain, type Filter, type GalleryData, HTML_MAX_BYTES, plural, refreshPhrase, run, type Summary } from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct } from "./common.tsx";

const FILTERS: { filter: Filter; label: string; count: keyof GalleryData["counts"] }[] = [
  { filter: "all", label: "All", count: "all" },
  { filter: "review", label: "Needs your review", count: "review" },
  { filter: "shared", label: "Shared", count: "shared" },
  { filter: "stale", label: "Not refreshing", count: "stale" },
  { filter: "archived", label: "Archived", count: "archived" },
];

/** The tags of a card or of the page header (same words in both). */
export function PageTags({ a }: { a: Pick<ArtifactInfo, "status" | "stagedVersion" | "links" | "sourcesPending" | "refresh"> }) {
  const review = a.sourcesPending > 0 || a.refresh.state === "waiting_approval";
  return (
    <div className="tb-row la-tags">
      {a.status === "archived" ? <Tag status="idle">Archived</Tag> : <Tag status="live">Live</Tag>}
      {review ? <Tag status="needs-you">Needs your review</Tag> : null}
      {a.links > 0 ? <Tag>{`Shared · ${plural(a.links, "link")}`}</Tag> : null}
      {a.stagedVersion !== null ? <Tag status="busy">New version waits for you</Tag> : null}
      {a.refresh.state === "paused_error" ? <Tag status="needs-you">Refresh paused</Tag> : null}
      {a.refresh.state === "paused" ? <Tag status="idle">Refresh on hold</Tag> : null}
    </div>
  );
}

function metaOf(a: Summary): string {
  if (a.sourcesPending > 0 || a.refresh.state === "waiting_approval") {
    const waits = a.sourcesPending > 0 ? `${plural(a.sourcesPending, "data source")} wait for you` : "a refresh schedule waits for you";
    return [`Made by ${a.createdBy.name}`, waits, refreshPhrase(a.refresh)].join(" · ");
  }
  if (a.refresh.state === "paused_error") return `Stopped after repeated failures${a.refresh.lastAt ? ` · shows data from ${ago(a.refresh.lastAt)}` : ""}`;
  return [`Updated ${ago(a.refresh.lastAt ?? a.updatedAt)}`, refreshPhrase(a.refresh), `made by ${a.createdBy.name}`].join(" · ");
}

function Card({ a, busy, onOpen, onResume }: { a: Summary; busy: boolean; onOpen: (id: string) => void; onResume: (a: Summary) => void }) {
  const review = a.sourcesPending > 0 || a.refresh.state === "waiting_approval";
  const href = `./page/${encodeURIComponent(a.id)}`;
  return (
    <article className="tb-card art" aria-label={a.title}>
      <h3>{a.title}</h3>
      {a.description ? <p className="tb-soft">{a.description}</p> : null}
      <PageTags a={a} />
      <span className="meta">{metaOf(a)}</span>
      <div className="tb-ctas">
        <ButtonLink
          size="sm"
          variant="primary"
          href={href}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab / window: let the link work
            e.preventDefault();
            onOpen(a.id);
          }}
        >
          {review ? "Review" : "Open"}
        </ButtonLink>
        {a.refresh.state === "paused_error" && a.refresh.everySeconds ? (
          <Button size="sm" onClick={() => onResume(a)} disabled={busy}>
            Resume refresh
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function Gallery({ onOpen, onCounts }: { onOpen: (id: string) => void; onCounts?: (review: number) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<GalleryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const { busy, error, act } = useAct();
  const seq = useRef(0);
  const counts = useRef(onCounts);
  counts.current = onCounts;

  const load = useCallback(
    async (f: Filter, cursor?: string) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const out = await run("gallery_view", cursor ? { filter: f, cursor } : { filter: f });
        if (mine !== seq.current) return;
        setData((prev) => (cursor && prev ? { ...out, items: [...prev.items, ...out.items] } : out));
        setLoadError(null);
        counts.current?.(out.counts.review);
      } catch (e) {
        if (mine === seq.current) setLoadError(explain(e));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  const resume = (a: Summary) =>
    act(async () => {
      await run("trigger_approve", { id: a.id, everySeconds: a.refresh.everySeconds });
      await load(filter);
    });

  return (
    <section className="app-page" aria-label="Gallery">
      <PageHead
        title="Gallery"
        lede="Pages your agents made. They stay here, refresh on their own, and keep working when the agent is gone. You decide what data they may show and who gets a link."
      >
        <Button onClick={() => setAdding(true)}>Add a page by hand</Button>
      </PageHead>
      <ChipGroup label="Filter">
        {FILTERS.map((f) => (
          <Chip key={f.filter} pressed={filter === f.filter} onClick={() => setFilter(f.filter)}>
            {f.label} {data ? data.counts[f.count] : 0}
          </Chip>
        ))}
      </ChipGroup>
      {data?.notices.map((n) => (
        <Notice key={n.code} tone="neutral" role="status">
          {n.message}
        </Notice>
      ))}
      <Failure message={error} />
      {loadError ? <LoadFailed message={loadError} retrying={loading} onRetry={() => void load(filter)} /> : null}
      {data === null ? (
        loadError ? null : (
          <p className="tb-soft" role="status">
            Loading the pages.
          </p>
        )
      ) : data.items.length === 0 ? (
        <EmptyState
          title={filter === "all" ? "No pages yet" : "No pages match this filter"}
          action={
            filter === "all" ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add a page by hand
              </Button>
            ) : undefined
          }
        >
          {filter === "all" ? "Agents create pages here. Ask an agent to save its output as a live page, or add one by hand." : "Pick another filter to see the rest."}
        </EmptyState>
      ) : (
        <>
          <div className="cards">
            {data.items.map((a) => (
              <Card key={a.id} a={a} busy={busy} onOpen={onOpen} onResume={(x) => void resume(x)} />
            ))}
          </div>
          {data.nextCursor ? (
            <div className="tb-ctas">
              <Button onClick={() => void load(filter, data.nextCursor ?? undefined)} disabled={loading}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
      <AddPage
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => void load(filter)}
        onOpen={(id) => {
          setAdding(false);
          onOpen(id);
        }}
      />
    </section>
  );
}

type Lint = Awaited<ReturnType<typeof addPage>>["lint"];
const addPage = (title: string, description: string, html: string) => run("artifact_new", { title, ...(description ? { description } : {}), html });

/** "Add a page by hand": a title and one HTML file. The server's lint advice is shown after the page is saved. */
function AddPage({ open, onClose, onAdded, onOpen }: { open: boolean; onClose: () => void; onAdded: () => void; onOpen: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: string; lint: Lint } | null>(null);
  const { busy, error, setError, act } = useAct();
  useEffect(() => {
    if (open) return;
    setTitle("");
    setDescription("");
    setHtml(null);
    setFileName("");
    setFileError(null);
    setAdded(null);
    setError(null);
  }, [open, setError]);

  const pick = async (file: File | undefined) => {
    setHtml(null);
    setFileError(null);
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > HTML_MAX_BYTES) return setFileError("The file is larger than 256 KiB. Pick a smaller one.");
    try {
      setHtml(await file.text());
    } catch {
      setFileError("Couldn’t read that file. Pick it again.");
    }
  };
  const save = () =>
    act(async () => {
      if (html === null) return;
      const out = await addPage(title.trim(), description.trim(), html);
      setAdded({ id: out.id, lint: out.lint });
      onAdded();
    });

  return (
    <Dialog
      open={open}
      title={added ? "Page added" : "Add a page by hand"}
      onClose={onClose}
      busy={busy}
      footer={
        added ? (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={() => onOpen(added.id)}>
              Open the page
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim() || html === null}>
            Add the page
          </Button>
        )
      }
    >
      <Failure message={error} />
      {added ? (
        <div className="tb-stack">
          <p className="tb-soft">The page is saved as version 1. Nothing is shared yet.</p>
          {added.lint.length === 0 ? (
            <p className="tb-soft">No advice. The page follows the rules.</p>
          ) : (
            <ul className="la-advice" aria-label="Advice">
              {added.lint.map((l) => (
                <li key={`${l.code}:${l.message}`}>{l.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <Field label="Title">
            <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" hint="Optional">
            <TextInput value={description} maxLength={400} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="HTML file" hint="One self-contained file, at most 256 KiB. Outside files are removed when the page is shown; use data: URLs." error={fileError ?? undefined}>
            <input type="file" accept=".html,.htm,text/html" onChange={(e) => void pick(e.target.files?.[0])} />
          </Field>
          {fileName && !fileError ? <p className="tb-hint">{fileName}</p> : null}
        </>
      )}
    </Dialog>
  );
}
