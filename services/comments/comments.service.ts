// services/comments/comments.service.ts
// Supabase-Operationen für Job-Kommentare (append-only, MVP, online-only).
// Mappt DB-Rows (snake_case) auf das App-Format (camelCase) — analog jobs.service.ts.
// Schreibrechte werden serverseitig zusätzlich per RLS geprüft (siehe lib/schema.sql).

import { supabase } from "@/lib/supabase";
import { CreateCommentInput, JobComment } from "@/types/comment";

// So sieht ein Kommentar direkt aus der Datenbank aus
type JobCommentRow = {
  id: string;
  job_id: string;
  author_id: string | null;
  message: string;
  created_at: string;
  // profiles kann (je nach Supabase-Join) Objekt, Array oder null sein
  profiles?:
    | { id: string; full_name: string | null }
    | { id: string; full_name: string | null }[]
    | null;
};

// Wandelt einen DB-Kommentar in unser App-Format um
function mapComment(row: JobCommentRow): JobComment {
  return {
    id: row.id,
    jobId: row.job_id,
    authorId: row.author_id,
    authorName: Array.isArray(row.profiles)
      ? row.profiles[0]?.full_name ?? null
      : row.profiles?.full_name ?? null,
    message: row.message,
    createdAt: row.created_at,
  };
}

const COMMENT_SELECT = `
  id,
  job_id,
  author_id,
  message,
  created_at,
  profiles:author_id (
    id,
    full_name
  )
`;

// Holt alle Kommentare zu einem Job (älteste zuerst, chronologisch).
export async function getJobComments(jobId: string): Promise<JobComment[]> {
  const { data, error } = await supabase
    .from("job_comments")
    .select(COMMENT_SELECT)
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((item) => mapComment(item as JobCommentRow));
}

// Legt einen neuen Kommentar an und gibt ihn im App-Format zurück.
export async function addJobComment(
  input: CreateCommentInput,
): Promise<JobComment> {
  // Nachricht serverseitig härten (nicht nur auf die UI verlassen)
  const message = input.message.trim();

  if (!message) {
    throw new Error("Bitte eine Nachricht eingeben.");
  }

  // Aktuellen User holen
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError) {
    throw authError;
  }

  const userId = authData.user?.id;

  if (!userId) {
    throw new Error("Kein eingeloggter Benutzer gefunden.");
  }

  // company_id aus dem Profil laden — wird für RLS (company-Scope) benötigt.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", userId)
    .single();

  if (profileError) {
    throw new Error("Profil konnte nicht geladen werden.");
  }

  if (!profile?.company_id) {
    throw new Error("Kein company_id im Profil gefunden.");
  }

  const payload = {
    company_id: profile.company_id,
    job_id: input.jobId,
    author_id: userId,
    message,
  };

  const { data, error } = await supabase
    .from("job_comments")
    .insert(payload)
    .select(COMMENT_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return mapComment(data as JobCommentRow);
}

// Liefert die Job-IDs mit ungelesenen Kommentaren für den aktuellen User.
// Die eigentliche Logik (neuester Kommentar > eigenes last_seen_at, eigene
// Kommentare ausgenommen, Rollen-/Firmen-Scope) steckt in der RPC.
export async function getUnreadCommentJobIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_unread_comment_job_ids");

  if (error) {
    throw error;
  }

  // Die RPC gibt `setof uuid` zurück → array von { get_unread_comment_job_ids }
  // oder array von strings, je nach PostgREST-Form. Beide Fälle abfangen.
  return ((data ?? []) as unknown[])
    .map((row) =>
      typeof row === "string"
        ? row
        : (row as { get_unread_comment_job_ids?: string })
            ?.get_unread_comment_job_ids ?? null,
    )
    .filter((id): id is string => typeof id === "string");
}

// Markiert die Kommentare eines Jobs für den aktuellen User als gesehen
// (Upsert auf last_seen_at = jetzt). Online-only, keine Offline-Queue.
export async function markJobCommentsAsRead(jobId: string): Promise<void> {
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError) {
    throw authError;
  }

  const userId = authData.user?.id;

  if (!userId) {
    throw new Error("Kein eingeloggter Benutzer gefunden.");
  }

  const { error } = await supabase
    .from("job_comment_reads")
    .upsert(
      {
        job_id: jobId,
        user_id: userId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "job_id,user_id" },
    );

  if (error) {
    throw error;
  }
}
