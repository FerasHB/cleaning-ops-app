// types/absence.ts
// Typen für Urlaub/Krankheit (Phase B — Employee Absence UI).
// Backend siehe supabase/migrations/20260816000000_absences_foundation.sql:
// ein typ-diskriminiertes Modell (type + status), Schreibzugriff ausschließlich
// über RPCs (services/absences/absences.service.ts).

export type AbsenceType = "vacation" | "sickness";

// vacation: requested | approved | rejected | cancelled
// sickness: reported | cancelled
export type AbsenceStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "cancelled"
  | "reported";

export type Absence = {
  id: string;
  companyId: string;
  employeeId: string | null;
  employeeName: string;
  type: AbsenceType;
  status: AbsenceStatus;
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD", nur bei Krankheit ohne bekanntes Ende null */
  endDate: string | null;
  employeeNote: string | null;
  adminNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestVacationInput = {
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD" */
  endDate: string;
  note?: string;
};

export type ReportSicknessInput = {
  /** "YYYY-MM-DD" */
  startDate: string;
  /** "YYYY-MM-DD", optional — Ende noch unbekannt */
  endDate?: string | null;
  note?: string;
};
