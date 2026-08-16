// features/absences/hooks/useAbsences.ts
// Lädt "Meine Abwesenheiten" und kapselt die Stornier-/Update-Aktionen.
// Gleiches Muster wie andere Feature-Hooks (z. B. useJobComments): eigener
// Ladezustand, eigener Fehlerzustand, kein globaler Context — Abwesenheiten
// sind bewusst online-only, keine Offline-Queue (siehe Backend-Migration).
//
// `load` wird bewusst NICHT mehr per Mount-Effect selbst aufgerufen — das ist
// jetzt Sache des Aufrufers via `useFocusEffect` (siehe AbsencesScreen), exakt
// das Muster aus AdminRecurringRulesScreen/JobDetailScreen: `app/absences/
// request-vacation` bzw. `report-sickness` sind eigene Stack-Screens, die
// beim Zurücknavigieren AbsencesScreen NICHT neu mounten. Ein reiner
// Mount-Effect würde die Liste nach einem erfolgreichen Antrag/Meldung
// dauerhaft veraltet stehen lassen.

import {
  cancelOwnSickness,
  cancelOwnVacation,
  getMyAbsences,
  reportOwnSickness,
  requestOwnVacation,
  updateOwnSicknessEnd,
} from "@/services/absences/absences.service";
import type {
  Absence,
  ReportSicknessInput,
  RequestVacationInput,
} from "@/types/absence";
import { toUserMessage } from "@/utils/userMessages";
import { useCallback, useEffect, useRef, useState } from "react";

export function useAbsences() {
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

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
      const data = await getMyAbsences();
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
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ silent: true });
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [load]);

  const upsertLocal = useCallback((updated: Absence) => {
    setAbsences((prev) => {
      const exists = prev.some((a) => a.id === updated.id);
      if (exists) return prev.map((a) => (a.id === updated.id ? updated : a));
      return [updated, ...prev];
    });
  }, []);

  const runAction = useCallback(
    async <T,>(id: string, action: () => Promise<T>): Promise<T | null> => {
      setActionBusyId(id);
      setActionError("");
      try {
        return await action();
      } catch (err) {
        if (mountedRef.current) {
          setActionError(toUserMessage(err, "Die Aktion konnte nicht ausgeführt werden."));
        }
        return null;
      } finally {
        if (mountedRef.current) setActionBusyId(null);
      }
    },
    [],
  );

  const requestVacation = useCallback(
    async (input: RequestVacationInput) => {
      const result = await requestOwnVacation(input);
      upsertLocal(result);
      return result;
    },
    [upsertLocal],
  );

  const reportSickness = useCallback(
    async (input: ReportSicknessInput) => {
      const result = await reportOwnSickness(input);
      upsertLocal(result);
      return result;
    },
    [upsertLocal],
  );

  const cancelVacation = useCallback(
    (id: string) =>
      runAction(id, async () => {
        const result = await cancelOwnVacation(id);
        upsertLocal(result);
        return result;
      }),
    [runAction, upsertLocal],
  );

  const cancelSickness = useCallback(
    (id: string) =>
      runAction(id, async () => {
        const result = await cancelOwnSickness(id);
        upsertLocal(result);
        return result;
      }),
    [runAction, upsertLocal],
  );

  const updateSicknessEnd = useCallback(
    (id: string, newEndDate: string | null) =>
      runAction(id, async () => {
        const result = await updateOwnSicknessEnd(id, newEndDate);
        upsertLocal(result);
        return result;
      }),
    [runAction, upsertLocal],
  );

  return {
    absences,
    loading,
    loadError,
    load,
    refreshing,
    refresh,
    actionBusyId,
    actionError,
    clearActionError: () => setActionError(""),
    requestVacation,
    reportSickness,
    cancelVacation,
    cancelSickness,
    updateSicknessEnd,
  };
}
