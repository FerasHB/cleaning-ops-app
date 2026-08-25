// utils/authDiagnosticsBuffer.ts
// ─────────────────────────────────────────────────────────────────
// TEMPORÄR — NUR FÜR DIE DIAGNOSE DES INTERMITTIERENDEN PKCE-RECOVERY-FEHLERS.
// Vor dem Merge ersatzlos entfernen (siehe utils/authDiagnostics.ts).
//
// Grund für die Existenz: console.log ist im installierten Preview-Build auf
// dem iPhone nicht auslesbar (macOS Console zeigt nur System-/CFNetwork-Logs
// für den Prozess, keine JS-console.log-Ausgaben). Dieser Ring-Buffer hält
// dieselben Diagnose-Events zusätzlich im Gerät vor, damit sie über einen
// In-App-Button als Text kopiert werden können — unabhängig von jedem
// externen Log-Viewer.
//
// Begrenzt auf MAX_EVENTS Zeilen (älteste fallen zuerst raus). Persistiert
// in AsyncStorage, damit auch Events VOR einem eventuellen Kaltstart durch
// den Deep-Link (App war geschlossen, Mail-App startet sie neu) erhalten
// bleiben.
//
// Es wird NIE ein Passwort, Code, code_verifier, Token, eine vollständige
// Recovery-URL oder ein Secret gespeichert — nur dieselben sicheren
// Metadaten wie in den bestehenden devLog/authDebug-Aufrufen (Zähler,
// Zustandsnamen, Fehlertypen, YES/NO).
// ─────────────────────────────────────────────────────────────────

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "taskops-temp-auth-diagnostics-buffer";
const MAX_EVENTS = 150;

let events: string[] = [];
let hydrated = false;
const pendingBeforeHydrate: string[] = [];

function trim() {
  if (events.length > MAX_EVENTS) {
    events = events.slice(events.length - MAX_EVENTS);
  }
}

function persistBestEffort() {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(events)).catch(() => {
    // Diagnose-Persistenz ist best effort — ein Fehler hier darf den
    // eigentlichen Auth-Flow nie beeinträchtigen.
  });
}

// Läuft beim Modul-Import einmalig an — lädt Events aus einer eventuell
// bereits laufenden vorherigen Sitzung (z.B. App wurde zwischen zwei
// Testversuchen beendet).
void AsyncStorage.getItem(STORAGE_KEY)
  .then((raw) => {
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          events = parsed.filter((e): e is string => typeof e === "string");
        }
      } catch {
        // Beschädigter/alter Buffer-Inhalt — einfach frisch beginnen.
      }
    }
    events.push(...pendingBeforeHydrate);
    pendingBeforeHydrate.length = 0;
    trim();
  })
  .catch(() => {
    events.push(...pendingBeforeHydrate);
    pendingBeforeHydrate.length = 0;
    trim();
  })
  .finally(() => {
    hydrated = true;
    persistBestEffort();
  });

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function timestamp(): string {
  // Nur Uhrzeit (nicht Datum) reicht für einen einzelnen Testlauf und hält
  // die Zeilen kurz.
  return new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "";
}

/** Fügt eine Diagnose-Zeile hinzu. Args werden wie in console.log verkettet. */
export function addDiagnosticEvent(...args: unknown[]): void {
  const line = `${timestamp()}  ${args.map(formatArg).join(" ")}`;
  if (!hydrated) {
    pendingBeforeHydrate.push(line);
    return;
  }
  events.push(line);
  trim();
  persistBestEffort();
}

/** Aktueller Buffer-Inhalt als zusammenhängender, kopierbarer Text. */
export function getDiagnosticEventsText(): string {
  return events.length > 0 ? events.join("\n") : "(keine Diagnose-Ereignisse aufgezeichnet)";
}

export function getDiagnosticEventsCount(): number {
  return events.length;
}

/** Leert den Buffer sowohl im Speicher als auch in AsyncStorage. */
export async function clearDiagnosticEvents(): Promise<void> {
  events = [];
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // best effort
  }
}
