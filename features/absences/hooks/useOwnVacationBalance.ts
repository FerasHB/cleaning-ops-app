// features/absences/hooks/useOwnVacationBalance.ts
// Lädt das eigene Urlaubskonto des laufenden Jahres.
//
// Gibt null zurück, solange NICHT beides gilt: Urlaubskonto aktiv UND Jahr
// initialisiert. Der Aufrufer zeigt dann gar keine Zahlen — ein "Resturlaub:
// 0" wäre falsch, weil ein gesetzlicher Anspruch unabhängig davon besteht.
//
// Rein lesend: der Mitarbeiter darf sein Konto nie verändern (RLS erlaubt
// ausschließlich SELECT auf den eigenen Zeilen).

import { useAuth } from "@/context/AuthContext";
import {
  getVacationLedger,
  getVacationYearId,
} from "@/services/vacation/vacationLedger.service";
import type { VacationBalance } from "@/types/vacationLedger";
import { buildVacationBalance } from "@/utils/vacationBalance";
import { useCallback, useEffect, useState } from "react";

export function useOwnVacationBalance(): VacationBalance | null {
  const { profile } = useAuth();
  const [balance, setBalance] = useState<VacationBalance | null>(null);
  const employeeId = profile?.id ?? null;

  const load = useCallback(async () => {
    if (!employeeId) {
      setBalance(null);
      return;
    }
    const year = new Date().getFullYear();
    try {
      const yearId = await getVacationYearId(employeeId, year);
      if (!yearId) {
        setBalance(null);
        return;
      }
      setBalance(buildVacationBalance(year, await getVacationLedger(yearId)));
    } catch {
      // Das Urlaubskonto ist eine Zusatzinformation — schlägt es fehl, bleibt
      // der Abwesenheits-Screen vollständig nutzbar (Antrag/Historie).
      setBalance(null);
    }
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  return balance;
}
