// features/absences/admin/hooks/useAdminAbsences.ts
// Lädt die zwei Listen von AdminAbsencesScreen ("Urlaubsanträge" +
// "Krankmeldungen") und kapselt die Genehmigen/Ablehnen-Aktion darüber.
// Gleiches Muster wie features/absences/hooks/useAbsences.ts: eigener
// Ladezustand, kein globaler Context, `load` wird per useFocusEffect vom
// Screen aufgerufen (nicht per Mount-Effect) — siehe dortige Begründung.

import {
  getPendingVacationRequests,
  getSicknessReports,
} from "@/services/absences/adminAbsences.service";
import type { Absence } from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVacationReview } from "./useVacationReview";

// Krankmeldungen-Reiter: aktive (reported) zuerst relevant, aber auch kürzlich
// stornierte sichtbar lassen (Nachvollziehbarkeit) — rejected/approved/
// requested gibt es für Krankheit ohnehin nicht (siehe CHECK-Constraint).
const SICKNESS_STATUSES: Absence["status"][] = ["reported", "cancelled"];

export function useAdminAbsences() {
  const [pendingVacations, setPendingVacations] = useState<Absence[]>([]);
  const [sicknessReports, setSicknessReports] = useState<Absence[]>([]);
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

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setLoadError("");
    try {
      const [vacations, sickness] = await Promise.all([
        getPendingVacationRequests(),
        getSicknessReports({ status: SICKNESS_STATUSES }),
      ]);
      if (mountedRef.current) {
        setPendingVacations(vacations);
        setSicknessReports(sickness);
      }
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(
          toUserMessage(err, "Die Abwesenheiten konnten nicht geladen werden."),
        );
      }
    } finally {
      if (mountedRef.current && !opts?.silent) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ silent: true });
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  // Ein genehmigter/abgelehnter Antrag verlässt die Pending-Liste (er ist per
  // Definition nicht mehr requested) — kein Reload nötig, reines Herausfiltern.
  const handleReviewed = useCallback((updated: Absence) => {
    setPendingVacations((prev) => prev.filter((a) => a.id !== updated.id));
  }, []);

  const review = useVacationReview(handleReviewed);

  return {
    pendingVacations,
    sicknessReports,
    loading,
    loadError,
    load,
    refreshing,
    refresh,
    ...review,
  };
}
