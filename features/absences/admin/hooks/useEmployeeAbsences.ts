// features/absences/admin/hooks/useEmployeeAbsences.ts
// Lädt die Abwesenheitshistorie eines einzelnen Mitarbeiters für den Admin —
// genutzt vom "Abwesenheiten"-Abschnitt in EmployeeDetailScreen (kompakter
// Ausschnitt) UND von EmployeeAbsenceHistoryScreen ("Alle anzeigen", höheres
// Limit). Gleiches Lade-/Review-Muster wie useAdminAbsences.

import { getEmployeeAbsences } from "@/services/absences/adminAbsences.service";
import type { Absence } from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVacationReview } from "./useVacationReview";

export function useEmployeeAbsences(employeeId: string | undefined, limit: number) {
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!employeeId) {
        setLoading(false);
        return;
      }
      if (!opts?.silent) setLoading(true);
      setLoadError("");
      try {
        const data = await getEmployeeAbsences(employeeId, limit);
        if (mountedRef.current) setAbsences(data);
      } catch (err) {
        if (mountedRef.current) {
          setLoadError(
            toUserMessage(err, "Die Abwesenheiten konnten nicht geladen werden."),
          );
        }
      } finally {
        if (mountedRef.current && !opts?.silent) setLoading(false);
      }
    },
    [employeeId, limit],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ silent: true });
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  const handleReviewed = useCallback((updated: Absence) => {
    setAbsences((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const review = useVacationReview(handleReviewed);

  return {
    absences,
    loading,
    loadError,
    load,
    refreshing,
    refresh,
    ...review,
  };
}
