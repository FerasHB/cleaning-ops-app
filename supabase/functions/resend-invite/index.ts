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
      { success: true, invitedAt },
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
