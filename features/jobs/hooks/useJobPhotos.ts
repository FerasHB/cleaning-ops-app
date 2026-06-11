// features/jobs/hooks/useJobPhotos.ts
// Lokaler State für Job-Fotos (online-only, kein Context, keine Offline-Queue).
// Kein Löschen im MVP — Fotos sind Nachweise.
// ImagePicker-Logik gehört nicht in diesen Hook, sondern in JobPhotos.tsx.

import { useAuth } from "@/context/AuthContext";
import {
  getJobPhotos,
  uploadJobPhoto,
} from "@/services/photos/photos.service";
import type { JobPhoto, UploadPhotoInput } from "@/types/photo";
import { isNetworkError } from "@/utils/networkError";
import { useCallback, useEffect, useState } from "react";

type UploadArgs = Omit<UploadPhotoInput, "jobId" | "companyId">;

export function useJobPhotos(jobId: string, isOnline: boolean) {
  const { profile } = useAuth();

  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True, wenn Fotos wegen fehlender Verbindung nicht geladen werden konnten.
  // Wird ruhig behandelt (kein roter Fehler) — Fotos sind online-only.
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    // Offline gar keinen Online-Request stellen (Fotos sind online-only).
    // Verhindert den fehlschlagenden fetch und damit das Dev-Error-Overlay.
    // Vorhandene Fotos bleiben erhalten.
    if (!isOnline) {
      setError(null);
      setOffline(true);
      setLoading(false);
      return;
    }

    try {
      setError(null);
      setOffline(false);
      const data = await getJobPhotos(jobId);
      setPhotos(data);
    } catch (err: unknown) {
      // Verbindung mitten im Request verloren → ruhig behandeln, kein roter
      // Fehler, vorhandene Fotos behalten.
      if (isNetworkError(err)) {
        setOffline(true);
        setError(null);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Fotos konnten nicht geladen werden.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [jobId, isOnline]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Lädt ein Foto hoch und fügt es direkt an den Anfang der Liste.
  // Wirft bei Fehler weiter, damit die UI ihn am Upload-Button anzeigen kann.
  // Der Aufrufer ist verantwortlich für online-Prüfung vor dem Aufruf.
  const upload = useCallback(
    async (args: UploadArgs) => {
      if (!profile?.company_id) {
        throw new Error(
          "Kein Unternehmen verknüpft. Bitte neu einloggen.",
        );
      }

      setUploading(true);
      setError(null);

      try {
        const newPhoto = await uploadJobPhoto({
          ...args,
          jobId,
          companyId: profile.company_id,
        });
        // Neues Foto vorne einfügen (neueste zuerst, analog Service-Sortierung)
        setPhotos((prev) => [newPhoto, ...prev]);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Upload fehlgeschlagen.";
        setError(message);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [jobId, profile?.company_id],
  );

  return { photos, loading, uploading, error, offline, upload, reload: load };
}
