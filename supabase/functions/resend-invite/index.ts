import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type ResendInviteBody = {
  employeeId?: string;
};

// Muss identisch zum Wert in create-employee/index.ts sein (siehe dortiger
// Kommentar + DEPLOY.md).
const INVITE_REDIRECT_TO = "taskopsmanager://accept-invite";

// Ziel des Passwort-Reset-Deep-Links — muss identisch zu dem Wert sein, den
// ForgotPasswordScreen/ResetPasswordScreen über Linking.createURL("reset-password")
// erzeugen (siehe features/auth/ForgotPasswordScreen.tsx), und ist bereits Teil
// der uri_allow_list (unverändert von dieser Änderung).
const PASSWORD_RESET_REDIRECT_TO = "taskopsmanager://reset-password";

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
      return Response.json(
        { error: "Nicht eingeloggt." },
        { status: 401, headers: corsHeaders },
      );
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return Response.json(
        { error: "Ungültige Session." },
        { status: 401, headers: corsHeaders },
      );
    }

    const { data: adminProfile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, company_id")
      .eq("id", user.id)
      .single();

    if (profileError || !adminProfile) {
      return Response.json(
        { error: "Admin-Profil konnte nicht geladen werden." },
        { status: 403, headers: corsHeaders },
      );
    }

    if (adminProfile.role !== "admin") {
      return Response.json(
        { error: "Nur Admins dürfen Einladungen erneut senden." },
        { status: 403, headers: corsHeaders },
      );
    }

    const body = (await req.json()) as ResendInviteBody;
    const employeeId = body.employeeId?.trim();

    if (!employeeId) {
      return Response.json(
        { error: "Mitarbeiter-ID fehlt." },
        { status: 400, headers: corsHeaders },
      );
    }

    // Ziel-Profil laden — nur Mitarbeiter der EIGENEN Firma dürfen erneut
    // eingeladen werden (verhindert firmenübergreifenden Zugriff über eine
    // erratene ID).
    const { data: targetProfile, error: targetError } = await adminClient
      .from("profiles")
      .select("id, role, company_id, full_name, invite_accepted_at")
      .eq("id", employeeId)
      .single();

    if (targetError || !targetProfile) {
      return Response.json(
        { error: "Mitarbeiter nicht gefunden." },
        { status: 404, headers: corsHeaders },
      );
    }

    if (
      targetProfile.company_id !== adminProfile.company_id ||
      targetProfile.role !== "employee"
    ) {
      return Response.json(
        { error: "Nicht erlaubt." },
        { status: 403, headers: corsHeaders },
      );
    }

    if (targetProfile.invite_accepted_at) {
      return Response.json(
        {
          error:
            "Dieser Mitarbeiter hat seine Einladung bereits angenommen und hat ein eigenes Passwort.",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    // profiles hat keine email-Spalte — die E-Mail kommt aus auth.users.
    const { data: authUser, error: authUserError } =
      await adminClient.auth.admin.getUserById(employeeId);

    if (authUserError || !authUser.user?.email) {
      return Response.json(
        { error: "E-Mail-Adresse konnte nicht ermittelt werden." },
        { status: 404, headers: corsHeaders },
      );
    }

    // ── Invite-Limbo-Erkennung (Staging-Diagnose 2026-09-05/06) ──────────
    // auth.users.confirmed_at (bzw. email_confirmed_at) wird bereits gesetzt,
    // sobald der /verify-Schritt eines Einladungs-Links durchläuft — das
    // passiert VOR und UNABHÄNGIG davon, ob der Mitarbeiter im
    // accept-invite-Screen danach tatsächlich ein Passwort setzt. Läuft die
    // eingebettete Sitzung ab, bevor das geschieht, bleibt das Konto
    // bestätigt, aber profiles.invite_accepted_at für immer NULL (der obige
    // Guard hätte hier bereits 400 geliefert, wäre das Feld gesetzt).
    // inviteUserByEmail() schlägt für ein bereits bestätigtes Konto IMMER mit
    // GoTrue 422 "email_exists" fehl — erneutes Einladen ist für diesen
    // Zustand kein gangbarer Weg. Richtiger Weg: derselbe Passwort-Reset-Weg,
    // den ein Mitarbeiter auch selbst über "Passwort vergessen" auslösen
    // könnte (resetPasswordForEmail, dieselbe GoTrue-Route, dasselbe SMTP).
    // ResetPasswordScreen schließt die Einladung serverseitig über
    // accept_own_invite() ab (siehe 20260906000000_...), sobald das neue
    // Passwort dort gesetzt wird — kein Sonderpfad nötig.
    const isConfirmed = Boolean(
      authUser.user.confirmed_at ?? authUser.user.email_confirmed_at,
    );

    if (isConfirmed) {
      const { error: recoverError } = await adminClient.auth
        .resetPasswordForEmail(authUser.user.email, {
          redirectTo: PASSWORD_RESET_REDIRECT_TO,
        });

      if (recoverError) {
        return Response.json(
          {
            error:
              recoverError.message ??
              "Passwort-Link konnte nicht verschickt werden.",
          },
          { status: 400, headers: corsHeaders },
        );
      }

      // invited_at bewusst NICHT aktualisiert: das Feld bedeutet "zuletzt
      // EINGELADEN" (siehe 20260718000000_employee_invitations.sql) — dieser
      // Zweig verschickt keine neue Einladung, sondern einen Recovery-Link
      // für ein bereits bestätigtes Konto.
      return Response.json(
        { success: true, mode: "recovery" },
        { headers: corsHeaders },
      );
    }

    // Nicht bestätigt: normaler Resend-Invite-Pfad (unverändert).
    // inviteUserByEmail auf einen bereits (unbestätigt) existierenden Nutzer
    // regeneriert den Einladungs-Link und verschickt die Mail erneut.
    const { error: inviteError } = await adminClient.auth.admin
      .inviteUserByEmail(authUser.user.email, {
        data: {
          full_name: targetProfile.full_name,
        },
        redirectTo: INVITE_REDIRECT_TO,
      });

    if (inviteError) {
      return Response.json(
        {
          error:
            inviteError.message ?? "Einladung konnte nicht erneut verschickt werden.",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const invitedAt = new Date().toISOString();

    const { error: updateError } = await adminClient
      .from("profiles")
      .update({ invited_at: invitedAt })
      .eq("id", employeeId);

    if (updateError) {
      return Response.json(
        { error: "Einladungs-Zeitstempel konnte nicht aktualisiert werden." },
        { status: 500, headers: corsHeaders },
      );
    }

    return Response.json(
      { success: true, mode: "invite", invitedAt },
      { headers: corsHeaders },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unbekannter Fehler.";

    return Response.json(
      { error: message },
      { status: 500, headers: corsHeaders },
    );
  }
});
