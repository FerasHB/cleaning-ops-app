// services/account/recoveryExport.core.ts
// Work Recovery S1.7: reine Prüf-/Formatfunktionen für den Recovery-Export
// vor der Firmenlöschung (keine React-Native-/Expo-Importe, damit
// scripts/check-recovery-export.mjs sie direkt unter Node testen kann).
//
// Datenquelle: RPC get_company_recovery_export_file() (Migration
// 20261123000000). Sie liefert die vollständige S1.5-Antwort als exakten
// Server-Text (file_text) plus SHA-256 dieses Texts (file_sha256, UTF-8).
// Die App schreibt file_text UNVERÄNDERT in die Datei — nie ein neu
// serialisiertes Objekt, weil JSON.parse Zahlen wie 1.50 oder große
// Ganzzahlen aus Mitarbeiter-Nachweisen verfälschen würde.
//
// Diese Datei protokolliert nichts (kein console.*): der Export enthält
// interne Admin-Notizen und personenbezogene Nachweise.

export type RecoveryRecordCounts = {
  cases: number;
  submissions: number;
  action_refs: number;
  events: number;
};

export type ValidatedRecoveryExport = {
  exportId: string;
  fingerprint: string;
  generatedAt: string;
  counts: RecoveryRecordCounts;
  openCaseCount: number;
  totalRecords: number;
  fileText: string;
  fileSha256: string;
};

export type RecoveryExportErrorKind =
  | "unsupported_platform"
  | "unauthenticated"
  | "not_authorized"
  | "invalid_response"
  | "write_failed"
  | "verify_failed"
  | "not_required"
  | "not_confirmed"
  | "stale"
  | "transport"
  | "unknown";

// Fehler ohne jeden Export-Inhalt in der Meldung (nur die Art).
export class RecoveryExportError extends Error {
  readonly kind: RecoveryExportErrorKind;
  constructor(kind: RecoveryExportErrorKind) {
    super(`recovery_export_${kind}`);
    this.name = "RecoveryExportError";
    this.kind = kind;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const COUNT_KEYS = ["cases", "submissions", "action_refs", "events"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readCounts(v: unknown): RecoveryRecordCounts | null {
  if (!isRecord(v)) return null;
  const out: Partial<RecoveryRecordCounts> = {};
  for (const key of COUNT_KEYS) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[key] = n;
  }
  return out as RecoveryRecordCounts;
}

/**
 * Prüft die Server-Antwort auf Vollständigkeit und innere Stimmigkeit.
 * Wirft RecoveryExportError("invalid_response"), wenn irgendetwas fehlt oder
 * nicht zusammenpasst — eine unvollständige Datei darf nie bestätigt werden.
 */
export function validateRecoveryExportResponse(raw: unknown): ValidatedRecoveryExport {
  const fail = () => new RecoveryExportError("invalid_response");
  if (!isRecord(raw) || raw.format !== "work_recovery_export_file_v1") throw fail();

  const { export_id, fingerprint, generated_at, file_text, file_sha256, open_case_count } = raw;
  if (typeof export_id !== "string" || !UUID_RE.test(export_id)) throw fail();
  if (typeof fingerprint !== "string" || !HEX64_RE.test(fingerprint)) throw fail();
  if (typeof generated_at !== "string" || generated_at.length === 0) throw fail();
  if (typeof file_text !== "string" || file_text.length === 0) throw fail();
  if (typeof file_sha256 !== "string" || !HEX64_RE.test(file_sha256)) throw fail();
  if (typeof open_case_count !== "number" || !Number.isInteger(open_case_count) || open_case_count < 0) {
    throw fail();
  }
  const counts = readCounts(raw.record_counts);
  if (!counts) throw fail();

  // Struktur des Datei-Inhalts prüfen. Das geparste Objekt dient NUR der
  // Prüfung; geschrieben wird immer file_text.
  let doc: unknown;
  try {
    doc = JSON.parse(file_text);
  } catch {
    throw fail();
  }
  if (!isRecord(doc)) throw fail();
  if (doc.export_id !== export_id || doc.fingerprint !== fingerprint) throw fail();
  if (!isRecord(doc.people)) throw fail();
  const inner = readCounts(doc.record_counts);
  if (!inner) throw fail();
  const recovery = doc.recovery;
  if (!isRecord(recovery) || recovery.format !== "work_recovery_export_v1") throw fail();
  for (const key of COUNT_KEYS) {
    const list = recovery[key];
    if (!Array.isArray(list)) throw fail();
    if (list.length !== counts[key] || inner[key] !== counts[key]) throw fail();
  }
  if (doc.open_case_count !== open_case_count) throw fail();

  return {
    exportId: export_id,
    fingerprint,
    generatedAt: generated_at,
    counts,
    openCaseCount: open_case_count,
    totalRecords: COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0),
    fileText: file_text,
    fileSha256: file_sha256,
  };
}

export function recoveryExportFileName(companyName: string, exportId: string, now: Date): string {
  const slug =
    companyName
      .normalize("NFKD")
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "company";
  return `taskops-recovery-${slug}-${now.toISOString().slice(0, 10)}-${exportId.slice(0, 8)}.json`;
}

/** Ordnet Server-/Transportfehler einer Fehlerart zu (ohne Inhalte). */
export function classifyRecoveryExportError(err: unknown): RecoveryExportErrorKind {
  if (err instanceof RecoveryExportError) return err.kind;
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (/recovery_export_stale/.test(message)) return "stale";
  if (code === "28000" || /unauthenticated/.test(message)) return "unauthenticated";
  if (code === "42501" || /not_authorized|export_not_found/.test(message)) return "not_authorized";
  if (/network|fetch|timeout|timed out|connection/i.test(message)) return "transport";
  return "unknown";
}

// =========================================================
// Ablauf
// =========================================================
// Work Recovery S1.7: Ablauf Export → Datei schreiben → Datei prüfen →
// ausdrückliche Bestätigung → Server-Bestätigung. Rein und mit
// eingespeisten Abhängigkeiten, damit Tests jeden Fehlerpfad beweisen können
// (scripts/check-recovery-export.mjs) und ein Integrationstest denselben Code
// gegen die echte Datenbank laufen lässt
// (supabase/tests/recovery_export_client_flow.test.sh).
//
// Sicherheitsregeln (S1.5 Regel B):
//   * Bestätigt wird NIE automatisch. acknowledgeRecoveryExport() verlangt
//     eine geprüfte Datei UND userConfirmed === true.
//   * "Geprüft" heißt: die Datei wurde geschrieben, wieder gelesen, ist
//     zeichengleich mit dem Server-Text und ihr SHA-256 (UTF-8) entspricht
//     file_sha256 vom Server. Der Teilen-Dialog beweist nichts (iOS/Android
//     melden Abbruch und Erfolg gleich) und wird hier nicht ausgewertet.
//   * Web: keine nachweisbare Datei (expo-file-system ist dort ein Stub) →
//     abgelehnt, bevor irgendetwas abgerufen wird.
//   * Der Server prüft beim Bestätigen und beim Löschen erneut, ob der
//     Export noch aktuell ist (recovery_export_stale).

export type RecoveryExportDeps = {
  platform: string;
  fetchExportFile(): Promise<unknown>;
  writeFile(fileName: string, text: string): Promise<{ uri: string }>;
  readFile(uri: string): Promise<string>;
  sha256Hex(text: string): Promise<string>;
  acknowledge(exportId: string): Promise<void>;
};

export type PreparedRecoveryExport = ValidatedRecoveryExport & {
  /** false = keine Recovery-Daten; keine Datei, keine Bestätigung nötig. */
  required: boolean;
  /** true nur nach erfolgreicher Schreib- + Lese- + Hash-Prüfung. */
  verified: boolean;
  uri: string | null;
  fileName: string | null;
};

export async function prepareRecoveryExport(
  deps: RecoveryExportDeps,
  companyName: string,
  now: Date = new Date(),
): Promise<PreparedRecoveryExport> {
  if (deps.platform === "web") throw new RecoveryExportError("unsupported_platform");

  let raw: unknown;
  try {
    raw = await deps.fetchExportFile();
  } catch (err) {
    throw new RecoveryExportError(classifyRecoveryExportError(err));
  }
  const exp = validateRecoveryExportResponse(raw);

  if (exp.totalRecords === 0) {
    return { ...exp, required: false, verified: false, uri: null, fileName: null };
  }

  const fileName = recoveryExportFileName(companyName, exp.exportId, now);
  let uri: string;
  try {
    ({ uri } = await deps.writeFile(fileName, exp.fileText));
  } catch {
    throw new RecoveryExportError("write_failed");
  }

  let readBack: string;
  let hash: string;
  try {
    readBack = await deps.readFile(uri);
    hash = (await deps.sha256Hex(readBack)).toLowerCase();
  } catch {
    throw new RecoveryExportError("verify_failed");
  }
  if (readBack !== exp.fileText || hash !== exp.fileSha256) {
    throw new RecoveryExportError("verify_failed");
  }

  return { ...exp, required: true, verified: true, uri, fileName };
}

export async function acknowledgeRecoveryExport(
  deps: RecoveryExportDeps,
  prepared: PreparedRecoveryExport | null,
  userConfirmed: boolean,
): Promise<void> {
  if (!prepared || !prepared.required) throw new RecoveryExportError("not_required");
  if (!prepared.verified || !prepared.uri) throw new RecoveryExportError("verify_failed");
  if (userConfirmed !== true) throw new RecoveryExportError("not_confirmed");
  try {
    await deps.acknowledge(prepared.exportId);
  } catch (err) {
    throw new RecoveryExportError(classifyRecoveryExportError(err));
  }
}
