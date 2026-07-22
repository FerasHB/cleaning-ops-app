import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Selbstlöschung des eigenen Kontos (DSGVO / Google-Play-Account-Deletion).
// Ein Nutzer darf AUSSCHLIESSLICH sein eigenes Konto löschen — es wird nie eine
// User-ID aus dem Request-Body akzeptiert, sondern immer die aus der Session
// (userClient.auth.getUser()). Die eigentliche Löschung läuft über den
// Service-Role-Admin-Client (admin.deleteUser); der Service-Key verlässt die
// Function nie. Gleiches Auth-Muster wie create-employee / resend-invite.
//
// Datenfolgen der Auth-User-Löschung (FKs, siehe lib/schema.sql):
// - profiles.id -> auth.users(id) ON DELETE CASCADE  → Profil (Name, Push-Token
//   etc.) wird mitgelöscht.
// - jobs.assigned_to / jobs.created_by            -> ON DELETE SET NULL (anonymisiert)
// - job_comments.author_id / job_photos.uploaded_by -> ON DELETE SET NULL (anonymisiert)
// - job_comment_reads.user_id                     -> ON DELETE CASCADE
// - notification_deliveries.recipient_id          -> ON DELETE CASCADE
// - notification_outbox.employee_id               -> ON DELETE SET NULL
// Firmen-/Auftragsdaten bleiben also erhalten, nur ohne Verknüpfung zum Konto.
//
// Schutz „letzter Admin": Ein Admin, der der EINZIGE aktive Admin seiner Firma
// ist, kann sich nicht löschen (Firma würde führungslos zurückbleiben). Er muss
// zuerst die Firma auflösen bzw. einen weiteren Admin haben. Existiert ein
// weiterer aktiver Admin, wird nur das anfragende Konto gelöscht.

type DeleteAccountErrorCode =
  | "unauthenticated"
  | "profile_not_found"
  | "last_admin"
  | "delete_failed"
  | "server_error";

function errorResponse(
  code: DeleteAccountErrorCode,
  message: string,
  status: number,
) {
  return Response.json(
    { success: false, code, error: message },
    { status, headers: corsHeaders },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return errorResponse("unauthenticated", "Nicht eingeloggt.", 401);
    }

    // Client im Namen des aufrufenden Nutzers (nur zum Ermitteln der Identität).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Privilegierter Client (Service Role) für Profil-Lookup + Löschung.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return errorResponse("unauthenticated", "Ungültige Session.", 401);
    }

    // Profil des Aufrufers laden (Rolle + Firma) — über den Admin-Client, damit
    // RLS die Prüfung nicht verfälscht.
    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, company_id")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      // Kein Profil (z. B. bereits gelöscht/inkonsistent): das Auth-Konto
      // trotzdem entfernen, damit keine verwaiste auth.users-Zeile bleibt.
      const { error: orphanDeleteError } =
        await adminClient.auth.admin.deleteUser(user.id);

      if (orphanDeleteError) {
        return errorResponse(
          "delete_failed",
          "Konto konnte nicht gelöscht werden.",
          500,
        );
      }

      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // ── Schutz „letzter Admin" ──
    if (profile.role === "admin" && profile.company_id) {
      const { count, error: countError } = await adminClient
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id)
        .eq("role", "admin")
        .eq("is_active", true)
        .neq("id", user.id);

      if (countError) {
        return errorResponse(
          "server_error",
          "Firmenprüfung fehlgeschlagen.",
          500,
        );
      }

      // Kein weiterer aktiver Admin → Firma wäre führungslos. Löschung sperren.
      if (!count || count === 0) {
        return errorResponse(
          "last_admin",
          "Als einziger Administrator kannst du dein Konto nicht löschen, " +
            "solange deine Firma noch existiert. Bitte entferne zuerst alle " +
            "Mitarbeiter und Auftragsdaten und löse die Firma auf, oder ernenne " +
            "einen weiteren Administrator.",
          409,
        );
      }
    }

    // ── Löschung: entfernt auth.users → cascade/set-null gemäß FKs oben. ──
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(
      user.id,
    );

    if (deleteError) {
      return errorResponse(
        "delete_failed",
        "Konto konnte nicht gelöscht werden.",
        500,
      );
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unbekannter Fehler.";

    return errorResponse("server_error", message, 500);
  }
});
