// services/employees/employmentConfig.service.ts
// ─────────────────────────────────────────────────────────────────
// Lesen/Schreiben der Beschäftigungs- und Urlaubskonfiguration eines
// Mitarbeiters (nur Admin).
//
// KEINE eigene RPC — bewusst: profiles hat keine "update own profile"-Policy,
// ein Mitarbeiter kann seine Zeile also gar nicht per UPDATE anfassen. Die
// einzige UPDATE-Policy ist "admin update profiles in own company"
// (firmengescopet in USING UND WITH CHECK), und der erweiterte Feld-Guard
// (20260823000000) schützt die neuen Spalten zusätzlich. Die Validierung
// liegt als CHECK-Constraint in der DB und greift damit auf JEDEM Schreibpfad.
// Eine zusätzliche SECURITY DEFINER-RPC brächte hier keine Sicherheit, nur
// mehr Angriffsfläche — gleiche Bauform wie setEmployeeActive().
// ─────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type {
  CompanyVacationDefaults,
  EmploymentConfig,
  EmploymentType,
} from "@/types/employment";

type ProfileConfigRow = {
  employment_type: EmploymentType | null;
  employment_start_date: string | null;
  employment_end_date: string | null;
  vacation_management_enabled: boolean | null;
  vacation_annual_entitlement_days: number | string | null;
  vacation_reference_days_per_week: number | string | null;
};

type CompanyDefaultsRow = {
  default_vacation_annual_entitlement_days: number | string | null;
  default_vacation_reference_days_per_week: number | string | null;
  default_vacation_management_enabled: boolean | null;
};

const PROFILE_CONFIG_SELECT =
  "employment_type, employment_start_date, employment_end_date, " +
  "vacation_management_enabled, vacation_annual_entitlement_days, " +
  "vacation_reference_days_per_week";

// PostgREST liefert numeric als STRING (Präzision geht sonst verloren).
// Ohne diese Umwandlung wären Vergleiche/Anzeigen subtil falsch.
function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function mapConfig(row: ProfileConfigRow): EmploymentConfig {
  return {
    employmentType: row.employment_type,
    employmentStartDate: row.employment_start_date,
    employmentEndDate: row.employment_end_date,
    vacationManagementEnabled: row.vacation_management_enabled ?? false,
    vacationAnnualEntitlementDays: toNumber(row.vacation_annual_entitlement_days),
    vacationReferenceDaysPerWeek: toNumber(row.vacation_reference_days_per_week),
  };
}

/** Konfiguration eines Mitarbeiters laden. */
export async function getEmploymentConfig(
  employeeId: string,
): Promise<EmploymentConfig> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_CONFIG_SELECT)
    .eq("id", employeeId)
    .single();

  if (error) throw error;
  if (!data) throw new Error("Mitarbeiter nicht gefunden.");

  return mapConfig(data as unknown as ProfileConfigRow);
}

/** Firmen-Defaults des aktuell eingeloggten Admins laden. */
export async function getCompanyVacationDefaults(): Promise<CompanyVacationDefaults> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;

  const userId = authData.user?.id;
  if (!userId) throw new Error("Kein eingeloggter Benutzer gefunden.");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", userId)
    .single();

  if (profileError) throw new Error("Profil konnte nicht geladen werden.");
  if (!profile?.company_id) throw new Error("Kein company_id im Profil gefunden.");

  const { data, error } = await supabase
    .from("companies")
    .select(
      "default_vacation_annual_entitlement_days, default_vacation_reference_days_per_week, default_vacation_management_enabled",
    )
    .eq("id", profile.company_id)
    .single();

  if (error) throw error;

  const row = (data ?? {}) as CompanyDefaultsRow;
  return {
    defaultAnnualEntitlementDays: toNumber(row.default_vacation_annual_entitlement_days ?? null),
    defaultReferenceDaysPerWeek: toNumber(row.default_vacation_reference_days_per_week ?? null),
    defaultVacationManagementEnabled: row.default_vacation_management_enabled ?? false,
  };
}

export type UpdateEmploymentConfigInput = {
  employeeId: string;
} & EmploymentConfig;

/**
 * Konfiguration speichern (nur Admin — serverseitig über RLS + Feld-Guard).
 *
 * Clientseitige Vorprüfung, damit der Nutzer eine verständliche deutsche
 * Meldung bekommt statt eines rohen Constraint-Fehlers. Die DB-CHECKs bleiben
 * die maßgebliche Instanz — diese Prüfung ersetzt sie NICHT.
 */
export async function updateEmploymentConfig(
  input: UpdateEmploymentConfigInput,
): Promise<EmploymentConfig> {
  const {
    employeeId,
    employmentStartDate,
    employmentEndDate,
    vacationAnnualEntitlementDays,
    vacationReferenceDaysPerWeek,
  } = input;

  if (
    employmentStartDate &&
    employmentEndDate &&
    employmentEndDate < employmentStartDate
  ) {
    throw new Error("Das Austrittsdatum darf nicht vor dem Eintrittsdatum liegen.");
  }

  if (
    vacationAnnualEntitlementDays !== null &&
    (vacationAnnualEntitlementDays < 0 || vacationAnnualEntitlementDays > 365)
  ) {
    throw new Error("Der Jahresanspruch muss zwischen 0 und 365 Tagen liegen.");
  }

  if (
    vacationReferenceDaysPerWeek !== null &&
    (vacationReferenceDaysPerWeek <= 0 || vacationReferenceDaysPerWeek > 7)
  ) {
    throw new Error("Die Referenz-Arbeitstage müssen zwischen 0 und 7 pro Woche liegen.");
  }

  const { data, error } = await supabase
    .from("profiles")
    .update({
      employment_type: input.employmentType,
      employment_start_date: employmentStartDate,
      employment_end_date: employmentEndDate,
      vacation_management_enabled: input.vacationManagementEnabled,
      vacation_annual_entitlement_days: vacationAnnualEntitlementDays,
      vacation_reference_days_per_week: vacationReferenceDaysPerWeek,
    })
    .eq("id", employeeId)
    .select(PROFILE_CONFIG_SELECT)
    .single();

  if (error) throw error;
  if (!data) {
    throw new Error(
      "Die Konfiguration konnte nicht gespeichert werden. Bitte prüfe deine Berechtigung.",
    );
  }

  return mapConfig(data as unknown as ProfileConfigRow);
}
