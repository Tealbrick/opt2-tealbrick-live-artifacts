// Settings: how long new links last, the viewer address and the refresh rules (mockup cards, C185).
import { Field, Select, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { explain, lifetimeOptions, run } from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct } from "./common.tsx";

export function SettingsPage() {
  const [days, setDays] = useState<number | null>(null);
  const [viewer, setViewer] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const { busy, error, act } = useAct();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // the setting comes with the gallery answer; "archived" is the filter that carries the fewest pages
      const out = await run("gallery_view", { filter: "archived" });
      setDays(out.settings.defaultLinkDays);
      setViewer(!out.notices.some((n) => n.code === "view_origin_missing"));
      setLoadError(null);
    } catch (e) {
      setLoadError(explain(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const change = (value: string) =>
    act(async () => {
      setSaved(false);
      const out = await run("settings_set", { defaultLinkDays: Number(value) });
      setDays(out.defaultLinkDays);
      setSaved(true);
    });

  const options = lifetimeOptions(days);
  return (
    <section className="app-page" aria-label="Settings">
      <PageHead title="Settings" />
      <Failure message={error} />
      {loadError ? <LoadFailed message={loadError} retrying={loading} onRetry={() => void load()} /> : null}
      <div className="cards">
        <article className="tb-card">
          <h3>Link lifetime</h3>
          <Field label="New links last" hint="You can pick another time for each link. A link never lasts longer than 90 days.">
            <Select value={days === null ? "" : String(days)} options={options} placeholder="Loading" disabled={days === null || busy} onValueChange={(v) => void change(v)} />
          </Field>
          {saved ? (
            <p className="tb-hint" role="status">
              Saved.
            </p>
          ) : null}
        </article>
        <article className="tb-card">
          <h3>Viewer address</h3>
          <div className="tb-row">
            {viewer === null ? <Tag status="idle">Checking</Tag> : viewer ? <Tag status="live">Ready</Tag> : <Tag status="idle">Not set yet</Tag>}
            <span className="tb-hint">
              Links open on a separate address of your bridge, never on the address of your apps. {viewer === false ? "Previews and links need it. Ask Portal to redeploy the bridge." : "Previews and links use it."}
            </span>
          </div>
        </article>
        <article className="tb-card">
          <h3>Refresh</h3>
          <p className="tb-soft">Pages refresh every 5 minutes at the fastest. After 5 failed tries a page stops refreshing and says so on the page and here.</p>
        </article>
      </div>
    </section>
  );
}
