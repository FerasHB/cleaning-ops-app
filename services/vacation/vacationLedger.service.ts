// services/vacation/vacationLedger.service.ts
// ─────────────────────────────────────────────────────────────────
// Urlaubskonto: Lesen des Ledgers + die drei buchenden Admin-Aktionen.
//
// SCHREIBEN ausschließlich über SECURITY DEFINER-RPCs — auf vacation_years
// und vacation_ledger existiert bewusst KEINE insert/update/delete-Policy.
// Append-only ist damit strukturell erzwungen, nicht bloß per UI versteckt.
// ─────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type {
  VacationLedgerEntry,
  VacationLedgerEntryType,
} from "@/types/vacationLedger";

type LedgerRow = {
  id: string;
  entry_type: VacationLedgerEntryType;
  amount_days: number | string;
  absence_id: string | null;
  created_by: string | null;
  note: string | null;
  created_at: string;
};

// PostgREST liefert numeric als String — ohne Umwandlung würde die
// Saldo-Summe zur String-Verkettung.
function toNumber(value: number | string): number {
  return typeof value === "string" ? Number(value) : value;
}

function mapEntry(row: LedgerRow): VacationLedgerEntry {
  return {
    id: row.id,
    entryType: row.entry_type,
    amountDays: toNumber(row.amount_days),
    absenceId: row.absence_id,
    createdBy: row.created_by,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** Urlaubsjahr-ID, falls bereits initialisiert (sonst null). */
export async function getVacationYearId(
  employeeId: string,
  year: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("vacation_years")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("year", year)
    .maybeSingle();

  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/** Alle Buchungszeilen eines Urlaubsjahres (chronologisch). */
export async function getVacationLedger(
  vacationYearId: string,
): Promise<VacationLedgerEntry[]> {
  const { data, error } = await supabase
    .from("vacation_ledger")
    .select("id, entry_type, amount_days, absence_id, created_by, note, created_at")
    .eq("vacation_year_id", vacationYearId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as unknown as LedgerRow[]).map(mapEntry);
}

/**
 * Urlaubsjahr anlegen und den Jahresanspruch buchen (Admin).
 *
 * Idempotent: ein zweiter Aufruf erzeugt weder ein zweites Jahr noch eine
 * zweite Anspruchszeile. Der Betrag wird serverseitig aus der Konfiguration
 * aufgelöst — der Client kann keine Menge vorgeben.
 */
export async function initializeVacationYear(
  employeeId: string,
  year: number,
): Promise<string> {
  const { data, error } = await supabase.rpc("admin_initialize_vacation_year", {
    p_employee_id: employeeId,
    p_year: year,
  });

  if (error) throw error;
  return data as string;
}

/** Manuelle Korrektur mit Pflicht-Begründung (Admin). */
export async function addVacationAdjustment(
  employeeId: string,
  year: number,
  amountDays: number,
  note: string,
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) {
    throw new Error("Bitte eine Begründung für die Korrektur angeben.");
  }
  if (!Number.isFinite(amountDays) || amountDays === 0) {
    throw new Error("Bitte einen Korrekturwert ungleich 0 angeben.");
  }

  const { error } = await supabase.rpc("admin_add_vacation_adjustment", {
    p_employee_id: employeeId,
    p_year: year,
    p_amount_days: amountDays,
    p_note: trimmed,
  });

  if (error) throw error;
}

/**
 * Wird für diesen Mitarbeiter ein Urlaubskonto geführt?
 *
 * Entscheidet, ob bei der Genehmigung eine Abzugsbestätigung verlangt wird.
 * Bewusst eine eigene, schmale Abfrage statt eines Flags im Absence-Objekt:
 * die Einstellung gehört zum Mitarbeiter, nicht zum Antrag, und kann sich
 * zwischen Antrag und Genehmigung ändern.
 */
export async function isVacationAccountingEnabled(
  employeeId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("vacation_management_enabled")
    .eq("id", employeeId)
    .maybeSingle();

  if (error) throw error;
  return (data as { vacation_management_enabled: boolean } | null)
    ?.vacation_management_enabled === true;
}
