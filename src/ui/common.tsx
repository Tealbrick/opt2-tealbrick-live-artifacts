// Small pieces the pages share: the failure notices (RUL-01, RUL-14) and the one-call-at-a-time guard (C8).
import { Button, Notice } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { explain } from "./api.ts";

/** A failed action: a plain sentence in an alert, never dropped (RUL-01). */
export function Failure({ message }: { message: string | null }) {
  return message ? (
    <Notice tone="needs-you" role="alert">
      {message}
    </Notice>
  ) : null;
}

/** A failed load: what happened and Try again, never an empty state that looks like "nothing here" (RUL-14). */
export function LoadFailed({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
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

export function PageHead({ title, tags, lede, children }: { title: ReactNode; tags?: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="tb-stack la-head">
        <h1>{title}</h1>
        {tags}
        {lede ? <p className="tb-lede">{lede}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * One call at a time (C8): `act` runs the call, keeps `busy` true while it runs and turns a failure into a plain
 * sentence in `error`. A second `act` while one runs does nothing (the ref closes the gap before React re-renders).
 */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(explain(e));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, act };
}
