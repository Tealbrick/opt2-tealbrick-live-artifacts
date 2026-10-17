// Every limit of the app in one place (DESIGN §4.1). Tests pin each value; handlers never use a literal.

export const LIMITS = {
  /** one HTML file per version, UTF-8 bytes */
  htmlBytes: 256 * 1024,
  /** contract JSON (normalised), bytes */
  contractBytes: 32 * 1024,
  /** one source `input` object (JCS), bytes */
  sourceInputBytes: 4 * 1024,
  /** versions kept per artifact besides the live, the staged and link-pinned ones */
  versionsKept: 20,
  /** sources (contract inputs) per artifact */
  sources: 8,
  /** one snapshot (pushed or read data), bytes */
  snapshotBytes: 256 * 1024,
  /** all snapshots of one artifact, bytes */
  artifactDataBytes: 1024 * 1024,
  /** artifacts per workspace (= this app instance) */
  artifactsPerWorkspace: 100,
  /** artifacts per gallery */
  artifactsPerGallery: 25,
  /** active viewer links per artifact and per workspace (S4) */
  linksPerArtifact: 5,
  linksPerWorkspace: 50,
  /** refresh interval bounds, seconds */
  refreshMinS: 300,
  refreshMaxS: 86_400,
  /** companion calls per hour from refreshes (all artifacts) */
  refreshCallsPerHour: 600,
  /** failed refresh ticks in a row before paused_error */
  refreshFailures: 5,
  /** agent artifact_refresh: one per artifact per this many ms */
  manualRefreshMs: 60_000,
  /** source_test sample rows */
  sampleRows: 10,
  /** list page sizes */
  listDefault: 20,
  listMax: 50,
  /** default viewer link lifetime (owner setting), days */
  defaultLinkDays: 7,
  maxLinkDays: 90,
} as const;

/** UTF-8 byte length of a string. */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
