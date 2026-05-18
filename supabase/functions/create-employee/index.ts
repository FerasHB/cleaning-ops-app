import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type CreateEmployeeBody = {
  fullName?: string;
  email?: string;
  password?: string;
};

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
        { error: "Nur Admins dürfen Mitarbeiter erstellen." },
        { status: 403, headers: corsHeaders },
      );
    }

    if (!adminProfile.company_id) {
      return Response.json(
        { error: "Admin hat keine company_id." },
        { status: 400, headers: corsHeaders },
      );
    }

    const body = (await req.json()) as CreateEmployeeBody;

    const fullName = body.fullName?.trim();
    const email = body.email?.trim().toLowerCase();
    const password = body.password?.trim();

    if (!fullName) {
      return Response.json(
        { error: "Name fehlt." },
        { status: 400, headers: corsHeaders },
      );
    }

    if (!email || !email.includes("@")) {
      return Response.json(
        { error: "Gültige E-Mail fehlt." },
        { status: 400, headers: corsHeaders },
      );
    }

    if (!password || password.length < 6) {
      return Response.json(
        { error: "Passwort muss mindestens 6 Zeichen haben." },
        { status: 400, headers: corsHeaders },
      );
    }

    const { data: createdUser, error: createUserError } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

    if (createUserError || !createdUser.user) {
      return Response.json(
        {
          error:
            createUserError?.message ?? "Mitarbeiter konnte nicht erstellt werden.",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const employeeId = createdUser.user.id;

    const { error: upsertProfileError } = await adminClient
      .from("profiles")
      .upsert({
        id: employeeId,
        full_name: fullName,
        role: "employee",
        company_id: adminProfile.company_id,
        is_active: true,
      });

    if (upsertProfileError) {
      return Response.json(
        { error: "Mitarbeiter-Profil konnte nicht erstellt werden." },
        { status: 500, headers: corsHeaders },
      );
    }

    return Response.json(
      {
        success: true,
        employee: {
          id: employeeId,
          fullName,
          email,
        },
      },
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