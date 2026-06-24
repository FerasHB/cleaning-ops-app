// features/timesheets/hooks/useTimesheet.ts
// State + Datenfluss für den Stundenzettel-Screen:
// Mitarbeiter-/Monatsauswahl, Laden der Einträge und PDF-Export.

import { useJobs } from "@/context/JobContext";
import {
  exportTimesheetPdf,
  getTimesheet,
} from "@/services/timesheets/timesheet.service";
import type { TimesheetData } from "@/types/timesheet";
import type { EmployeeOption } from "@/types/job";
import { useCallback, useEffect, useMemo, useState } from "react";

// In Version 1 neutraler, fest hinterlegter Firmenname (kein company.name-Fetch).
const COMPANY_NAME = "Cleaning Ops";

export type UseTimesheetResult = {
  employees: EmployeeOption[];
  selectedEmployeeId: string | null;
  setSelectedEmployeeId: (id: string) => void;
  /** Erster Tag des gewählten Monats (lokal). */
  monthDate: Date;
  goToPrevMonth: () => void;
  goToNextMonth: () => void;
  /** Anzeige z.B. "Juni 2026". */
  monthLabel: string;
  /** true, wenn der gewählte Monat der aktuelle Monat ist (kein "Weiter"). */
  isCurrentMonth: boolean;
  data: TimesheetData | null;
  loading: boolean;
  error: string | null;
  exporting: boolean;
  exportError: string | null;
  exportPdf: () => Promise<void>;
};

// Erster Tag des Monats von `date` (lokal, auf Mitternacht normalisiert).
function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

export function useTimesheet(): UseTimesheetResult {
  const { employees } = useJobs();

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
    null,
  );
  const [monthDate, setMonthDate] = useState<Date>(() =>
    startOfMonth(new Date()),
  );

  const [data, setData] = useState<TimesheetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const monthLabel = useMemo(
    () =>
      monthDate.toLocaleDateString("de-DE", {
        month: "long",
        year: "numeric",
      }),
    [monthDate],
  );

  const isCurrentMonth = useMemo(() => {
    const now = startOfMonth(new Date());
    return (
      monthDate.getFullYear() === now.getFullYear() &&
      monthDate.getMonth() === now.getMonth()
    );
  }, [monthDate]);

  const goToPrevMonth = useCallback(() => {
    setMonthDate((prev) => startOfMonth(new Date(prev.getFullYear(), prev.getMonth() - 1, 1)));
  }, []);

  const goToNextMonth = useCallback(() => {
    setMonthDate((prev) => {
      const next = startOfMonth(new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
      // Nicht in die Zukunft springen (Stundenzettel gibt es nur bis heute).
      const currentMonth = startOfMonth(new Date());
      return next > currentMonth ? prev : next;
    });
  }, []);

  // Lädt den Stundenzettel, sobald Mitarbeiter + Monat feststehen.
  useEffect(() => {
    if (!selectedEmployeeId) {
      setData(null);
      setError(null);
      return;
    }

    const employee = employees.find((e) => e.id === selectedEmployeeId);
    const employeeName = employee?.fullName ?? "Mitarbeiter";

    let cancelled = false;
    setLoading(true);
    setError(null);

    getTimesheet({
      companyName: COMPANY_NAME,
      employeeId: selectedEmployeeId,
      employeeName,
      year: monthDate.getFullYear(),
      month: monthDate.getMonth() + 1,
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Stundenzettel konnte nicht geladen werden.",
          );
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedEmployeeId, monthDate, employees]);

  const exportPdf = useCallback(async () => {
    if (!data || data.entries.length === 0) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportTimesheetPdf(data);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "PDF-Export fehlgeschlagen.",
      );
    } finally {
      setExporting(false);
    }
  }, [data]);

  return {
    employees,
    selectedEmployeeId,
    setSelectedEmployeeId,
    monthDate,
    goToPrevMonth,
    goToNextMonth,
    monthLabel,
    isCurrentMonth,
    data,
    loading,
    error,
    exporting,
    exportError,
    exportPdf,
  };
}
