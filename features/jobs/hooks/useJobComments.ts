// features/jobs/hooks/useJobComments.ts
// Lokaler State für Job-Kommentare (online-only, kein Context, keine Offline-Queue).
// Lädt beim Mount und nach jedem erfolgreichen Submit neu.

import {
  addJobComment,
  getJobComments,
} from "@/services/comments/comments.service";
import { JobComment } from "@/types/comment";
import { isNetworkError } from "@/utils/networkError";
import { toUserMessage } from "@/utils/userMessages";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function useJobComments(jobId: string) {
  const { t } = useTranslation();
  const [comments, setComments] = useState<JobComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getJobComments(jobId);
      setComments(data);
    } catch (err: unknown) {
      // Offline-/Netzwerkfehler ist erwartbar (Kommentare sind online-only):
      // kein console.error/Redbox, ruhige UI-Meldung statt hartem Fehler.
      if (isNetworkError(err)) {
        setError(t("jobs:comments.offlineLoadError"));
      } else {
        console.error("Failed to load comments:", err);
        // toUserMessage() statt rohem err.message — vorher konnte hier ein
        // ungefilterter Supabase-/PostgREST-Fehler (Tabellen-/Constraint-
        // Namen) direkt in der UI landen (siehe i18n-Audit, "raw backend
        // error" Fund).
        setError(toUserMessage(err, t("jobs:comments.loadFailed")));
      }
    } finally {
      setLoading(false);
    }
  }, [jobId, t]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Legt einen Kommentar an und lädt danach neu.
  // Wirft bei Fehler weiter, damit die UI ihn am Eingabefeld anzeigen kann.
  const submit = useCallback(
    async (message: string) => {
      await addJobComment({ jobId, message });
      await load();
    },
    [jobId, load],
  );

  return { comments, loading, error, submit };
}
