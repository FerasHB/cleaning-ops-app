// types/photo.ts
// Typen für Job-Fotos (Upload + Anzeige, MVP).
// Kein Löschen im MVP — Fotos sind Nachweise.

export type JobPhoto = {
  id: string;
  jobId: string;
  companyId: string;
  // uploaded_by ist nullable + on delete set null: verlässt der Uploader
  // die Firma / löscht sein Konto, bleibt das Foto als Nachweis erhalten,
  // ist danach aber nicht mehr mit einem Konto verknüpft (siehe
  // supabase/migrations/20260722000000_fix_job_photos_uploaded_by_on_delete.sql).
  uploadedBy: string | null;
  storagePath: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  // Wird nach dem Laden aus dem Storage befüllt (Signed URL, kein getPublicUrl).
  // Nicht in der DB gespeichert.
  signedUrl: string | null;
};

export type UploadPhotoInput = {
  jobId: string;
  companyId: string;
  uri: string;       // Lokaler Dateipfad vom ImagePicker
  fileName: string;
  mimeType: string;
  fileSize: number;
};
