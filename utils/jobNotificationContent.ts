// utils/jobNotificationContent.ts
// ─────────────────────────────────────────────────────────────────
// Textbausteine für Job-Push-Benachrichtigungen. Bewusst REINE
// Formatierung ohne Seiteneffekte und ohne Supabase-Zugriff, damit die
// Segment-Reihenfolge und die Kürzungsregeln ohne Netzwerk nachvollziehbar
// (und später testbar) bleiben.
//
// Warum hier und nicht im Service: `jobs.service.ts` entscheidet WANN
// gesendet wird, dieses Modul entscheidet WAS drinsteht. Gleiches Muster
// wie utils/jobSchedule.ts (Terminierung) und utils/jobAssignees.ts
// (Zuweisungs-Anzeige) — Anzeige-/Textlogik gehört nicht in den Service.
//
// Die Gegenstelle für „gestartet"/„abgeschlossen" liegt serverseitig in
// supabase/functions/dispatch-notifications/index.ts (buildContent). Dort
// stehen nur employee_name/customer_name/service_name zur Verfügung — die
// Claim-RPC liefert bewusst keine Adresse und keine Terminierung.
// ─────────────────────────────────────────────────────────────────

import { formatDateISO, normalizeTime } from "@/utils/date";
import { formatRecurringDays } from "@/utils/recurrence";
import type { JobType } from "@/types/job";

// Trennzeichen zwischen den Segmenten. Mittelpunkt statt Komma, damit
// Kundennamen mit Komma ("Müller, Meier & Co.") nicht mit der Segment-
// Grenze verschwimmen.
const SEPARATOR = " · ";

// Die Adresse ist das am NIEDRIGSTEN priorisierte Segment: sie kommt nur
// dazu, wenn sie kurz ist UND der Gesamttext dadurch nicht ausufert.
// Android zeigt eingeklappt nur ~40–50 Zeichen; alles danach sieht der
// Mitarbeiter erst nach dem Aufklappen. Service/Kunde/Zeit sind wichtiger.
const MAX_LOCATION_LENGTH = 30;
const MAX_BODY_LENGTH = 100;

// Fallback, falls ausnahmsweise gar kein Segment gefüllt ist. Kunde, Ort
// und Service sind in createJob Pflichtfelder, das sollte also nie greifen —
// eine leere Push-Nachricht wäre aber deutlich schlimmer als ein Allgemeinplatz.
const FALLBACK_BODY = "Dir wurde ein neuer Auftrag zugewiesen.";

export type AssignedPushSchedule = {
  jobType: JobType;
  /** "YYYY-MM-DD" — nur bei single gesetzt. */
  date?: string | null;
  /** "HH:mm" oder "HH:mm:ss" (DB-Format). */
  startTime?: string | null;
  /** Kurzcodes "mon"…"sun" — nur bei recurring gesetzt. */
  recurringDays?: string[] | null;
};

export type AssignedPushInput = {
  serviceName?: string | null;
  customerName?: string | null;
  locationAddress?: string | null;
  schedule: AssignedPushSchedule;
};

/**
 * Terminangabe für die Push-Zeile.
 *
 *   single    → "Heute 18:00" | "Morgen 18:00" | "12.08. 18:00"
 *   recurring → "Mo, Do · 18:00"
 *
 * Gibt null zurück, wenn weder Datum/Wochentage noch Uhrzeit bekannt sind.
 * `ref` ist injizierbar, damit "Heute"/"Morgen" deterministisch prüfbar ist.
 */
export function formatAssignedSchedule(
  schedule: AssignedPushSchedule,
  ref: Date = new Date(),
): string | null {
  const time = normalizeTime(schedule.startTime);

  if (schedule.jobType === "recurring") {
    const days = formatRecurringDays(schedule.recurringDays);
    // formatRecurringDays liefert "—" wenn die Liste leer ist — das ist ein
    // Anzeige-Platzhalter und gehört nicht in eine Push-Nachricht.
    const hasDays = days !== "—";
    if (!hasDays) return time;
    return time ? `${days}${SEPARATOR}${time}` : days;
  }

  const dateKey = schedule.date?.slice(0, 10) || null;
  if (!dateKey) return time;

  const dayLabel = formatRelativeDayLabel(dateKey, ref);
  return time ? `${dayLabel} ${time}` : dayLabel;
}

/** "Heute" | "Morgen" | "12.08." für ein "YYYY-MM-DD"-Datum. */
function formatRelativeDayLabel(dateKey: string, ref: Date): string {
  if (formatDateISO(ref) === dateKey) return "Heute";

  const tomorrow = new Date(ref);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (formatDateISO(tomorrow) === dateKey) return "Morgen";

  const [, month, day] = dateKey.split("-");
  // Jahr bewusst weglassen: in der Push-Zeile zählt Kürze, und ein Auftrag
  // liegt praktisch nie mehr als ein Jahr in der Zukunft.
  return `${day}.${month}.`;
}

/**
 * Body der "Neuer Auftrag"-Push.
 *
 *   "Büroreinigung · Müller GmbH · Heute 18:00"
 *   "Büroreinigung · Müller GmbH · Heute 18:00 · Bahnhofstr. 10"
 *
 * Reihenfolge = Informationshierarchie: WAS, für WEN, WANN, erst dann WO.
 * Die Adresse fällt automatisch weg, wenn sie lang ist (siehe Konstanten oben).
 */
export function buildAssignedPushBody(input: AssignedPushInput): string {
  const segments: string[] = [];

  const service = input.serviceName?.trim();
  if (service) segments.push(service);

  const customer = input.customerName?.trim();
  if (customer) segments.push(customer);

  const when = formatAssignedSchedule(input.schedule);
  if (when) segments.push(when);

  let body = segments.join(SEPARATOR);

  const location = input.locationAddress?.trim();
  if (location && location.length <= MAX_LOCATION_LENGTH) {
    const withLocation = body ? `${body}${SEPARATOR}${location}` : location;
    if (withLocation.length <= MAX_BODY_LENGTH) {
      body = withLocation;
    }
  }

  return body || FALLBACK_BODY;
}
