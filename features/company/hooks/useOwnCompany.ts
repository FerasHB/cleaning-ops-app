// features/company/hooks/useOwnCompany.ts
// Leichtgewichtiger Firmen-Fetch (kein Context) für die Firmen-Einstellungen
// und die Anzeige des echten Firmennamens (Dashboard-Titel, Profil-Badge).
//
// Bewusst KEIN globaler CompanyContext im MVP: die Firma ändert sich selten
// und wird nur an wenigen Stellen gebraucht. Wird das mehr, ist ein
// CompanyProvider neben JobProvider der Skalierungspfad.

import { getOwnCompany } from "@/services/company/company.service";
import type { Company } from "@/types/company";
import { isNetworkError } from "@/utils/networkError";
import { useCallback, useEffect, useState } from "react";

type UseOwnCompanyResult = {
  company: Company | null;
  loading: boolean;
  /** Echter Server-/RLS-Fehler (nicht offline). */
  error: string | null;
  reload: () => Promise<void>;
  /** Optimistisch nach einem erfolgreichen Update setzen. */
  setCompany: (next: Company) => void;
};

export function useOwnCompany(): UseOwnCompanyResult {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const c = await getOwnCompany();
      setCompany(c);
    } catch (err) {
      if (!isNetworkError(err)) {
        console.error("useOwnCompany: load failed", err);
        setError("Firmendaten konnten nicht geladen werden.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { company, loading, error, reload, setCompany };
}
