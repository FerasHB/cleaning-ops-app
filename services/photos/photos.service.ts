// services/photos/photos.service.ts
// Supabase-Operationen für Job-Fotos (Upload + Anzeige, MVP, online-only).
// Kein Löschen im MVP — Fotos sind Nachweise.
// Bucket "job-photos" ist private → Zugriff nur über Signed URLs.
// Pfadkonvention im Bucket: {company_id}/{job_id}/{timestamp}_{zufallsstring}.{ext}

import { supabase } from "@/lib/supabase";
import type { JobPhoto, UploadPhotoInput } from "@/types/photo";

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = "job-photos";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Dauer der Signed URL in Sekunden (1 Stunde)
const SIGNED_URL_EXPIRES_IN = 60 * 60;

// ─────────────────────────────────────────────────────────────────────────────
// Interne Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

// Gibt die Dateiendung für einen MIME-Type zurück.
function extensionForMime(mime: AllowedMimeType): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

// Prüft MIME-Type und Dateigröße clientseitig, bevor etwas hochgeladen wird.
// Wirft einen deutschen Fehlertext, der direkt in der UI angezeigt werden kann.
function validateUploadInput(mimeType: string, fileSize: number): AllowedMimeType {
  const isAllowed = (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);

  if (!isAllowed) {
    // HEIC und alle anderen unbekannten Formate landen hier.
    throw new Error(
      "Dieses Dateiformat wird nicht unterstützt. Bitte wähle ein Foto im Format JPEG, PNG oder WebP.",
    );
  }

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    const maxMb = MAX_FILE_SIZE_BYTES / (1024 * 1024);
    const actualMb = (fileSize / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Das Foto ist zu groß (${actualMb} MB). Maximal erlaubt sind ${maxMb} MB.`,
    );
  }

  return mimeType as AllowedMimeType;
}

// Liest eine lokale Datei als ArrayBuffer.
// React Native unterstützt fetch() für lokale file://-URIs (iOS + Android).
// response.arrayBuffer() ist in Hermes (RN 0.64+) verfügbar und deutlich
// performanter als eine charCodeAt-Schleife über Base64 — kein einfrieren
// des JS-Threads bei großen Fotos.
async function readFileAsArrayBuffer(uri: string): Promise<ArrayBuffer> {
  const response = await fetch(uri);
  return response.arrayBuffer();
}

// Baut den Storage-Pfad: {company_id}/{job_id}/{timestamp}_{random}.{ext}
function buildStoragePath(
  companyId: string,
  jobId: string,
  mime: AllowedMimeType,
): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const ext = extensionForMime(mime);
  return `${companyId}/${jobId}/${timestamp}_${random}.${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne DB-Typen → App-Typen
// ─────────────────────────────────────────────────────────────────────────────

type JobPhotoRow = {
  id: string;
  job_id: string;
  company_id: string;
  uploaded_by: string | null;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

function mapPhoto(row: JobPhotoRow): JobPhoto {
  return {
    id: row.id,
    jobId: row.job_id,
    companyId: row.company_id,
    uploadedBy: row.uploaded_by,
    storagePath: row.storage_path,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    signedUrl: null, // wird in getJobPhotos befüllt
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Öffentliche Service-Funktionen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lädt ein Foto hoch und speichert die Metadaten in job_photos.
 *
 * Ablauf:
 *   1. Clientseitige Validierung (MIME-Type, Dateigröße)
 *   2. Datei lesen und in Storage hochladen
 *   3. Metadaten in job_photos schreiben
 *   4. Bei DB-Fehler: Storage-Datei wieder entfernen (best-effort Rollback)
 */
export async function uploadJobPhoto(input: UploadPhotoInput): Promise<JobPhoto> {
  const { jobId, companyId, uri, fileName, mimeType, fileSize } = input;

  // 1. Validierung — wirft bei Fehler eine deutsche Fehlermeldung
  const validMime = validateUploadInput(mimeType, fileSize);

  // 2. Storage-Pfad aufbauen und Datei hochladen
  const storagePath = buildStoragePath(companyId, jobId, validMime);
  const arrayBuffer = await readFileAsArrayBuffer(uri);

  const { error: storageError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, arrayBuffer, {
      contentType: validMime,
      upsert: false,
    });

  if (storageError) {
    throw new Error(
      `Foto konnte nicht hochgeladen werden: ${storageError.message}`,
    );
  }

  // 3. Metadaten in Tabelle speichern
  const { data, error: dbError } = await supabase
    .from("job_photos")
    .insert({
      job_id: jobId,
      company_id: companyId,
      uploaded_by: (await supabase.auth.getUser()).data.user?.id,
      storage_path: storagePath,
      file_name: fileName,
      file_size: fileSize,
      mime_type: validMime,
    })
    .select()
    .single();

  if (dbError) {
    // 4. Best-effort Rollback: Datei aus Storage entfernen
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new Error(
      `Foto wurde hochgeladen, aber konnte nicht gespeichert werden: ${dbError.message}`,
    );
  }

  const photo = mapPhoto(data as JobPhotoRow);

  // Signed URL für das soeben hochgeladene Foto erzeugen
  const { data: signedData, error: signedError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN);

  if (!signedError && signedData?.signedUrl) {
    photo.signedUrl = signedData.signedUrl;
  }
  // Fehler bei der Signed URL ist nicht kritisch — Foto wurde gespeichert.
  // signedUrl bleibt null; die UI zeigt einen Platzhalter.

  return photo;
}

/**
 * Lädt alle Fotos eines Jobs und ergänzt Signed URLs für die Anzeige.
 * Neueste Fotos zuerst.
 */
export async function getJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const { data, error } = await supabase
    .from("job_photos")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(
      `Fotos konnten nicht geladen werden: ${error.message}`,
    );
  }

  if (!data || data.length === 0) {
    return [];
  }

  const photos = data.map((row) => mapPhoto(row as JobPhotoRow));

  // Alle Signed URLs in einem einzigen Request holen (createSignedUrls)
  const paths = photos.map((p) => p.storagePath);
  const { data: signedData, error: signedError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_EXPIRES_IN);

  if (signedError || !signedData) {
    // Signed URLs konnten nicht geholt werden — Fotos zurückgeben ohne URLs.
    // Die UI zeigt Platzhalter; kein harter Fehler.
    return photos;
  }

  // Signed URLs den passenden Fotos zuweisen
  const urlByPath = new Map(
    signedData.map((entry) => [entry.path, entry.signedUrl]),
  );
  for (const photo of photos) {
    photo.signedUrl = urlByPath.get(photo.storagePath) ?? null;
  }

  return photos;
}
