// features/absences/admin/hooks/useVacationReview.ts
// Kapselt Genehmigen/Ablehnen eines Urlaubsantrags (admin_review_vacation).
// Geteilt zwischen AdminAbsencesScreen und EmployeeDetailScreen — beide
// zeigen dieselbe Aktion auf denselben Zeilen, nur in unterschiedlichem
// Listenkontext. Ruft bei Erfolg `onReviewed(updated)` auf, damit der
// Aufrufer die lokale Liste optimistisch aktualisiert (kein Reload nötig).

import {
  reviewVacation,
  type AdminCreateAbsenceInput,
} from "@/services/absences/adminAbsences.service";
import type { Absence } from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";
import { useCallback, useEffect, useRef, useState } from "react";

// Re-export nur für Konsumenten, die den Input-Typ ebenfalls brauchen
// (AdminCreateAbsenceScreen) — vermeidet einen doppelten Import-Pfad.
export type { AdminCreateAbsenceInput };

export function useVacationReview(onReviewed: (updated: Absence) => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const approve = useCallback(
    async (absenceId: string) => {
      setBusyId(absenceId);
      setError("");
      try {
        const updated = await reviewVacation(absenceId, "approved");
        onReviewed(updated);
        return updated;
      } catch (err) {
        setError(toUserMessage(err, "Der Urlaub konnte nicht genehmigt werden."));
        return null;
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [onReviewed],
  );

  const reject = useCallback(
    async (absenceId: string, adminNote?: string) => {
      setBusyId(absenceId);
      setError("");
      try {
        const updated = await reviewVacation(absenceId, "rejected", adminNote);
        onReviewed(updated);
        return updated;
      } catch (err) {
        setError(toUserMessage(err, "Der Urlaub konnte nicht abgelehnt werden."));
        return null;
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [onReviewed],
  );

  return {
    busyId,
    error,
    clearError: () => setError(""),
    approve,
    reject,
  };
}
