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
//   (employee_name wird per Trigger durch "Gelöschtes Konto" ersetzt)
// Firmen-/Auftragsdaten bleiben also erhalten, nur ohne Verknüpfung zum Konto.
// Die Namens-Snapshots in job_assignments/employee_absences bleiben als
// Referenz der Firmen-Nachweise erhalten (Migration 20261026000000, rechtlich
// zu prüfen) — die Lösch-UI verspricht deshalb keine Anonymisierung.
//
// Letzter Admin (Store-Compliance, Migration 20261026000000): Ist der
// Aufrufer der EINZIGE aktive Admin seiner Firma, löscht er mit seinem Konto
// die Firma, die Firmendaten und alle Mitarbeiterkonten. Bestimmte
// Arbeitszeit-/Beschäftigungsnachweise archiviert die RPC vorher minimal und
// gesperrt in compliance_retention_records (Migration 20261027000000). Das passiert nur,
// wenn der Client es ausdrücklich bestätigt ({ confirmCompanyDeletion: true,
// confirmCompanyId }) — ohne Bestätigung antwortet die Function weiterhin mit
// 409 / last_admin. Die Firmen-ID im Body ist NUR eine Bestätigung: die RPC
// purge_company_for_last_admin() ermittelt Firma und Rolle selbst aus dem
// Profil der Session-Identität und lehnt jede abweichende ID ab
// ('company_mismatch'). Existiert ein weiterer aktiver Admin, wird nur das
// anfragende Konto gelöscht (normaler Pfad unten).
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
  | "not_last_admin"
  | "company_mismatch"
  | "purge_failed"
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

const PHOTO_BUCKET = "job-photos";

type DeleteAccountBody = {
  confirmCompanyDeletion?: unknown;
  confirmCompanyId?: unknown;
};

async function readBody(req: Request): Promise<DeleteAccountBody> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as DeleteAccountBody : {};
  } catch {
    return {};
  }
}

// Storage-Dateien einer gelöschten Firma entfernen. SQL darf storage.objects
// nicht löschen (storage.protect_delete), deshalb über die Storage-API mit dem
// Service-Role-Client. Zwei Quellen: die von der RPC gemeldeten Pfade (alle
// job_photos-/absence_evidence-Zeilen zum Purge-Zeitpunkt) UND alles unter dem
// Firmen-Präfix <company_id>/ (fängt Uploads ab, deren DB-Zeile fehlt).
// Idempotent: nicht (mehr) vorhandene Dateien sind kein Fehler.
async function removeCompanyStorage(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  companyId: string,
  reportedPaths: string[],
): Promise<"ok" | "partial"> {
  const bucket = adminClient.storage.from(PHOTO_BUCKET);
  const paths = new Set(reportedPaths.filter((p) => typeof p === "string" && p));
  let complete = true;

  // Präfix-Listing: <company_id>/<job_id>/<datei> — zwei Ebenen.
  const { data: folders, error: listError } = await bucket.list(companyId, { limit: 1000 });
  if (listError) {
    complete = false;
  } else {
    for (const entry of folders ?? []) {
      if (entry.id) {
        paths.add(`${companyId}/${entry.name}`);
        continue;
      }
      const { data: files, error: filesError } = await bucket.list(
        `${companyId}/${entry.name}`,
        { limit: 1000 },
      );
      if (filesError) {
        complete = false;
        continue;
      }
      for (const file of files ?? []) {
        paths.add(`${companyId}/${entry.name}/${file.name}`);
      }
    }
  }

  const all = [...paths];
  for (let i = 0; i < all.length; i += 100) {
    const { error } = await bucket.remove(all.slice(i, i + 100));
    if (error) complete = false;
  }

  return complete ? "ok" : "partial";
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
    const body = await readBody(req);
    const confirmCompanyDeletion = body.confirmCompanyDeletion === true;
    const confirmCompanyId =
      typeof body.confirmCompanyId === "string" ? body.confirmCompanyId : null;

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

    // ── Letzter Admin: Firma + Konto löschen (nur mit Bestätigung) ──
    // Die RPC prüft serverseitig ALLES erneut (Identität = user.id aus der
    // Session, Rolle, aktiv, Firma == Bestätigung, wirklich letzter Admin) und
    // löscht in EINER Transaktion. user.id kommt aus getUser(), nie aus dem
    // Body.
    if (confirmCompanyDeletion) {
      if (!confirmCompanyId) {
        return errorResponse(
          "company_mismatch",
          "Die Firmenlöschung wurde nicht eindeutig bestätigt.",
          400,
        );
      }

      const { data: purge, error: purgeError } = await adminClient.rpc(
        "purge_company_for_last_admin",
        { p_caller: user.id, p_confirm_company_id: confirmCompanyId },
      );

      if (purgeError) {
        switch (purgeError.message) {
          case "not_last_admin":
            return errorResponse(
              "not_last_admin",
              "Deine Firma hat inzwischen einen weiteren aktiven " +
                "Administrator. Die Firma wird nicht gelöscht — bitte öffne " +
                "die Kontolöschung erneut.",
              409,
            );
          case "company_mismatch":
          case "not_admin":
            return errorResponse(
              "company_mismatch",
              "Die bestätigte Firma passt nicht zu deinem Konto.",
              403,
            );
          case "inactive_account":
            return errorResponse(
              "inactive_account",
              "Dein Konto ist deaktiviert. Bitte wende dich an deinen " +
                "Administrator.",
              403,
            );
          default:
            console.error("delete-account: purge_company_for_last_admin failed", {
              userId: user.id,
              message: purgeError.message,
            });
            return errorResponse(
              "purge_failed",
              "Firma und Konto konnten nicht gelöscht werden. Es wurde " +
                "nichts gelöscht.",
              500,
            );
        }
      }

      const companyId = String(purge?.company_id ?? confirmCompanyId);
      const storagePaths = Array.isArray(purge?.storage_paths)
        ? purge.storage_paths as string[]
        : [];
      let storageCleanup: "ok" | "partial" = "partial";
      try {
        storageCleanup = await removeCompanyStorage(adminClient, companyId, storagePaths);
      } catch (storageError) {
        console.error("delete-account: storage cleanup threw", {
          companyId,
          message: storageError instanceof Error ? storageError.message : String(storageError),
        });
      }
      if (storageCleanup !== "ok") {
        // Firma/Konten sind bereits gelöscht (Transaktion committed). Reste im
        // Bucket sind ohne Firmenmitgliedschaft für niemanden mehr lesbar
        // (Storage-RLS hängt am Firmenpräfix) — für manuelles Nachräumen loggen.
        console.error("delete-account: storage cleanup incomplete", { companyId });
      }

      const retainedRecordCount = Number(purge?.retained_record_count ?? 0);

      return Response.json(
        { success: true, companyDeleted: true, storageCleanup, retainedRecordCount },
        { headers: corsHeaders },
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
        // Ohne ausdrückliche Bestätigung NIE die Firma löschen. Ältere
        // App-Versionen kennen den Bestätigungsschritt nicht und zeigen nur
        // diesen Text an.
        return errorResponse(
          "last_admin",
          "Du bist der einzige aktive Administrator. Wenn du dein Konto " +
            "löschst, werden auch deine Firma und alle Firmendaten dauerhaft " +
            "gelöscht. Bitte bestätige das in der aktuellen App-Version unter " +
            "Profil → Konto löschen.",
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
