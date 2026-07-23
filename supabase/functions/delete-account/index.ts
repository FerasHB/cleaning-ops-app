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
//
// Race-Condition-Schutz: die Last-Admin-Prüfung läuft NICHT als separates
// SELECT hier in der Function (zwei Admins derselben Firma könnten sich
// sonst fast zeitgleich löschen und beide "es gibt ja noch einen anderen
// Admin" sehen). Stattdessen ruft diese Function zuerst die atomare RPC
// public.prepare_self_account_deletion() auf (auth.uid()-basiert, sperrt
// firmenweit alle Admin-Zeilen deterministisch) — sie gibt bei Erfolg einen
// Reservierungs-Token zurück. Schlägt das anschließende
// auth.admin.deleteUser() fehl, macht public.rollback_self_account_deletion()
// die Reservierung rückgängig, aber NUR mit genau diesem Token.
//
// Reservierung ≠ is_active: is_active bleibt ausschließlich der
// administrativen Deaktivierung vorbehalten (prepare/rollback fassen es nie
// an) — die Reservierung läuft komplett über account_deletion_token /
// account_deletion_reserved_at. Bricht diese Function irgendwo zwischen
// erfolgreichem prepare() und deleteUser()/rollback() ab (Crash, Timeout,
// Netzwerkfehler), bleibt eine "verwaiste" Reservierung zurück, die KEINE
// Auswirkung auf den Login/die Nutzung des Kontos hat (is_active
// unverändert) — sie blockiert lediglich, dass ein anderer Admin derselben
// Firma sich zeitgleich löscht. public.recover_stale_account_deletion_
// reservations() (nur service_role) räumt solche Reservierungen nach 15
// Minuten automatisch ab; diese Function ruft sie best-effort vor jedem
// neuen Löschversuch auf. Details:
// supabase/migrations/20260723000001_account_deletion_reservation_tokens.sql

type DeleteAccountErrorCode =
  | "unauthenticated"
  | "profile_not_found"
  | "inactive_account"
  | "last_admin"
  | "prepare_failed"
  | "delete_failed"
  | "rollback_failed"
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

    // Profil-Existenz prüfen — über den Admin-Client, damit RLS die Prüfung
    // nicht verfälscht. Rolle/Firma werden nicht mehr hier gebraucht: die
    // Last-Admin-Logik lebt jetzt vollständig in prepare_self_account_deletion().
    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      // Kein Profil (z. B. bereits gelöscht/inkonsistent): das Auth-Konto
      // trotzdem entfernen, damit keine verwaiste auth.users-Zeile bleibt.
      // Keine Last-Admin-Reservierung nötig — ohne Profil gibt es keine
      // Firmenzugehörigkeit zu schützen.
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

    // Best effort: veraltete Reservierungen (Crash/Timeout eines früheren
    // Löschversuchs, egal welcher Firma) vor diesem Versuch abräumen. Läuft
    // über den Service-Role-Client, da nur service_role diese RPC ausführen
    // darf. Ein Fehler hier ist nicht fatal für DIESEN Request — im
    // schlimmsten Fall bleibt eine veraltete Fremd-Reservierung noch aktiv
    // und der Aufrufer bekommt ggf. last_admin, obwohl der andere Admin
    // eigentlich längst abgebrochen ist; das behebt der nächste Versuch.
    const { error: recoverError } = await adminClient.rpc(
      "recover_stale_account_deletion_reservations",
    );

    if (recoverError) {
      console.error(
        "delete-account: recover_stale_account_deletion_reservations failed",
        { message: recoverError.message },
      );
    }

    // ── Schutz „letzter Admin" (atomar, RPC statt separates SELECT) ──
    // Über userClient aufrufen, NICHT adminClient: auth.uid() innerhalb der
    // RPC löst sich aus dem Authorization-Header dieses Requests auf — mit
    // dem Service-Role-Client wäre auth.uid() NULL. Für Mitarbeiter (und
    // Admins ohne Firma) ist dies ein no-op ohne Sperre, siehe RPC-Kommentar.
    const { data: reservationToken, error: prepareError } =
      await userClient.rpc("prepare_self_account_deletion");

    if (prepareError) {
      if (prepareError.message === "last_admin") {
        return errorResponse(
          "last_admin",
          "Als einziger Administrator kannst du dein Konto nicht löschen, " +
            "solange deine Firma noch existiert. Bitte entferne zuerst alle " +
            "Mitarbeiter und Auftragsdaten und löse die Firma auf, oder ernenne " +
            "einen weiteren Administrator.",
          409,
        );
      }

      if (prepareError.message === "inactive_account") {
        return errorResponse(
          "inactive_account",
          "Dein Konto ist deaktiviert. Bitte wende dich an deinen " +
            "Administrator.",
          403,
        );
      }

      // Alles andere (profile_not_found, unerwarteter DB-Fehler): Details
      // nur ins Server-Log, dem Client nur eine generische Meldung.
      console.error("delete-account: prepare_self_account_deletion failed", {
        userId: user.id,
        message: prepareError.message,
      });
      return errorResponse(
        "prepare_failed",
        "Konto konnte nicht gelöscht werden.",
        500,
      );
    }

    // ── Löschung: entfernt auth.users → cascade/set-null gemäß FKs oben. ──
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(
      user.id,
    );

    if (deleteError) {
      // Reservierung mit dem exakten Token rückgängig machen — sonst bliebe
      // sie stehen, ohne dass das Konto gelöscht wurde (is_active ist davon
      // nie betroffen, siehe Kommentar oben; recover_stale_... würde sie
      // spätestens nach 15 Minuten ohnehin abräumen, aber der Rollback hier
      // macht das sofort, statt auf das Zeitfenster zu warten).
      console.error("delete-account: deleteUser failed, rolling back", {
        userId: user.id,
        message: deleteError.message,
      });

      const { error: rollbackError } = await userClient.rpc(
        "rollback_self_account_deletion",
        { p_token: reservationToken },
      );

      if (rollbackError) {
        console.error("delete-account: rollback_self_account_deletion failed", {
          userId: user.id,
          message: rollbackError.message,
        });
        return errorResponse(
          "rollback_failed",
          "Konto konnte nicht gelöscht werden und die Wiederherstellung ist " +
            "fehlgeschlagen. Bitte kontaktiere den Support.",
          500,
        );
      }

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
