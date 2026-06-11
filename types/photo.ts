// types/photo.ts
// Typen für Job-Fotos (Upload + Anzeige, MVP).
// Kein Löschen im MVP — Fotos sind Nachweise.

export type JobPhoto = {
  id: string;
  jobId: string;
  companyId: string;
  uploadedBy: string;
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
