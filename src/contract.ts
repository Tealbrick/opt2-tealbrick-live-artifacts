// The artifact contract (DESIGN §3.0): what an agent writes against. Strict: fields that a later stage will use are
// refused with `unsupported_in_this_version`, never ignored (L3). The manifest schema checks the shape; this module
// checks what JSON Schema cannot (unique keys, companion ops, sizes, one schedule) and normalises the result.
import { canonicalize, digest } from "@opt2-tealbrick/manifest";
import { type Json, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { LIMITS, utf8Bytes } from "./limits.ts";

export interface Projection {
  path?: string;
  pick?: string[];
  limit?: number;
}
export interface PushInput {
  key: string;
  kind: "push";
  label: string;
}
export interface ReadInput {
  key: string;
  kind: "read";
  label: string;
  product: string;
  op: string;
  input: Record<string, Json>;
  projection: Projection;
}
export type ContractInput = PushInput | ReadInput;
export interface Contract {
  v: 1;
  inputs: ContractInput[];
  /** v0: at most one schedule trigger */
  schedule: { everySeconds: number } | null;
}

export const EMPTY_CONTRACT: Contract = { v: 1, inputs: [], schedule: null };

/** Raw contract as the manifest schema admits it. */
export interface RawContract {
  v: number;
  inputs?: Array<{
    key: string;
    kind: string;
    label?: string;
    product?: string;
    op?: string;
    input?: Record<string, unknown>;
    projection?: Record<string, unknown>;
  }>;
  triggers?: Array<{ kind: string; everySeconds?: number; source?: unknown }>;
  output?: unknown;
  program?: unknown;
}

/** Ops another app lets us read, from the manifest companions (single source; read-only grants). */
export type CompanionOps = ReadonlyMap<string, ReadonlySet<string>>;
export function companionOps(manifest: { companions?: readonly { product: string; operations: readonly string[]; crud: readonly string[] }[] }): CompanionOps {
  const m = new Map<string, Set<string>>();
  for (const c of manifest.companions ?? []) {
    if (c.crud.length !== 1 || c.crud[0] !== "read") continue; // only read-only companions may feed a page
    m.set(c.product, new Set(c.operations));
  }
  return m;
}

const unsupported = (what: string, stage: string) => new TbError("unsupported_in_this_version", `${what} is not supported in this version (planned: ${stage})`, 400);
const bad = (code: string, message: string) => new TbError(code, message, 400);

function projectionOf(raw: Record<string, unknown> | undefined, key: string): Projection {
  if (!raw) return {};
  for (const f of ["where", "sort", "count"]) if (f in raw) throw unsupported(`projection.${f} (source "${key}")`, "version 0.2");
  const p: Projection = {};
  if (typeof raw.path === "string" && raw.path !== "") {
    if (!raw.path.startsWith("/")) throw bad("projection_invalid", `projection.path of source "${key}" must be a JSON pointer that starts with "/"`);
    p.path = raw.path;
  }
  if (Array.isArray(raw.pick) && raw.pick.length > 0) p.pick = [...new Set(raw.pick as string[])];
  if (typeof raw.limit === "number") p.limit = raw.limit;
  return p;
}

/** Validates and normalises a contract; throws TbError with a precise code. */
export function normalizeContract(raw: RawContract | undefined, companions: CompanionOps): Contract {
  if (!raw) return EMPTY_CONTRACT;
  if (raw.v !== 1) throw bad("contract_version", "contract.v must be 1");
  if (raw.output !== undefined) throw unsupported("contract.output (data output for agents)", "version 0.2");
  if (raw.program !== undefined) throw unsupported("contract.program (server runtime)", "version 0.5");
  const inputs: ContractInput[] = [];
  const keys = new Set<string>();
  for (const i of raw.inputs ?? []) {
    if (keys.has(i.key)) throw bad("source_key_duplicate", `two sources use the key "${i.key}"`);
    keys.add(i.key);
    const label = (i.label ?? "").trim();
    if (i.kind === "event") throw unsupported(`event source "${i.key}"`, "version 0.3");
    if (i.kind === "push") {
      if (i.product !== undefined || i.op !== undefined || i.input !== undefined || i.projection !== undefined)
        throw bad("source_invalid", `push source "${i.key}" takes no product, op, input or projection (you send its data with artifact_data_put)`);
      inputs.push({ key: i.key, kind: "push", label });
      continue;
    }
    if (i.kind !== "read") throw bad("source_invalid", `source "${i.key}": kind must be push or read`);
    if (!i.product || !i.op) throw bad("source_invalid", `read source "${i.key}" needs product and op`);
    const ops = companions.get(i.product);
    if (!ops?.has(i.op)) {
      const allowed = [...companions].map(([p, s]) => `${p}: ${[...s].join(", ")}`).join("; ");
      throw bad("source_not_allowed", `read source "${i.key}": ${i.product} ${i.op} is not a read this app may use (allowed: ${allowed})`);
    }
    const input = (i.input ?? {}) as Record<string, Json>;
    if (utf8Bytes(canonicalize(input)) > LIMITS.sourceInputBytes) throw bad("source_input_too_large", `read source "${i.key}": input is larger than ${LIMITS.sourceInputBytes} bytes`);
    inputs.push({ key: i.key, kind: "read", label, product: i.product, op: i.op, input, projection: projectionOf(i.projection, i.key) });
  }
  if (inputs.length > LIMITS.sources) throw bad("too_many_sources", `at most ${LIMITS.sources} sources`);
  let schedule: Contract["schedule"] = null;
  for (const t of raw.triggers ?? []) {
    if (t.kind === "event") throw unsupported("event trigger", "version 0.3");
    if (t.kind !== "schedule") throw bad("trigger_invalid", "trigger kind must be schedule");
    if (t.source !== undefined) throw unsupported("triggers[].source (event triggers)", "version 0.3");
    if (schedule) throw bad("trigger_duplicate", "at most one schedule trigger");
    if (typeof t.everySeconds !== "number") throw bad("trigger_invalid", "a schedule trigger needs everySeconds (300 to 86400)");
    schedule = { everySeconds: t.everySeconds };
  }
  const c: Contract = { v: 1, inputs, schedule };
  if (utf8Bytes(canonicalize(contractJson(c))) > LIMITS.contractBytes) throw bad("contract_too_large", `the contract is larger than ${LIMITS.contractBytes} bytes`);
  return c;
}

/** The contract as stored and returned (same field names as the input). */
export function contractJson(c: Contract): Json {
  const inputs: Json[] = c.inputs.map(
    (i): Json =>
      i.kind === "push"
        ? { key: i.key, kind: "push", label: i.label }
        : { key: i.key, kind: "read", label: i.label, product: i.product, op: i.op, input: i.input, projection: i.projection as Json },
  );
  return { v: 1, inputs, triggers: c.schedule ? [{ kind: "schedule", everySeconds: c.schedule.everySeconds }] : [] };
}

export function parseStoredContract(json: string): Contract {
  const raw = JSON.parse(json) as RawContract;
  const inputs: ContractInput[] = (raw.inputs ?? []).map((i) =>
    i.kind === "push"
      ? { key: i.key, kind: "push", label: i.label ?? "" }
      : { key: i.key, kind: "read", label: i.label ?? "", product: String(i.product), op: String(i.op), input: (i.input ?? {}) as Record<string, Json>, projection: (i.projection ?? {}) as Projection },
  );
  const t = (raw.triggers ?? []).find((x) => x.kind === "schedule");
  return { v: 1, inputs, schedule: t && typeof t.everySeconds === "number" ? { everySeconds: t.everySeconds } : null };
}

/** Binding digest (DESIGN §3.0, §4.4): sha256 of the JCS of the four fields the owner approves. Push sources bind to
 *  their key only (the agent's own data; no read of another app). */
export function sourceDigest(i: ContractInput): string {
  if (i.kind === "push") return digest({ kind: "push", key: i.key });
  return digest({ product: i.product, op: i.op, input: i.input, projection: i.projection as Json });
}
