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
  /** Optionale Rufnummer — wird nach E.164 normalisiert; ungültige ignoriert. */
  phone?: string;
};

// E.164-Normalisierung (deckungsgleich mit utils/phone.ts::normalizePhone,
// Standardland DE). Gibt null zurück, wenn daraus keine gültige Nummer wird.
function normalizePhoneE164(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let v = String(raw).replace(/[\s/().-]/g, "");
  if (v === "") return null;
  if (v.startsWith("00")) v = "+" + v.slice(2);
  else if (v.startsWith("+")) { /* wie eingegeben */ }
  else if (v.startsWith("0")) v = "+49" + v.slice(1);
  else if (/^\d+$/.test(v)) v = "+" + v;
  return /^\+[1-9]\d{6,14}$/.test(v) ? v : null;
}

// Deep-Link-Ziel der Einladungs-Mail — muss unter Supabase Dashboard →
// Authentication → URL Configuration → Redirect URLs eingetragen sein, sonst
// leitet Supabase NICHT dorthin um (siehe DEPLOY.md in diesem Ordner).
// Statisch, weil inviteUserByEmail server-seitig läuft (kein Linking.createURL
// möglich wie beim client-seitig ausgelösten Passwort-Reset) — funktioniert
// daher nur in Dev-Client-/Standalone-Builds mit dem "taskopsmanager"-Scheme,
// nicht in Expo Go.
const INVITE_REDIRECT_TO = "taskopsmanager://accept-invite";

type AuthUserLookup = { id: string; email?: string };

// Sucht einen Auth-Nutzer per exakter E-Mail, OHNE inviteUserByEmail
// aufzurufen (kein Einladungs-Mail-Seiteneffekt) und OHNE einen unbeschränkten
// listUsers()-Scan. GoTrue's Admin-REST-API unterstützt `filter` als
// serverseitig ausgeführte, gebundene Suche — gegen Staging verifiziert:
// leeres Array bei unbekannter E-Mail, Treffer bei bekannter. Das
// installierte @supabase/supabase-js gibt diesen Parameter über
// auth.admin.listUsers() NICHT durch (dessen Query-Objekt ist hart auf
// page/perPage begrenzt, siehe GoTrueAdminApi.js) — daher roher fetch gegen
// denselben Endpunkt, mit demselben service-role Key, den adminClient auch
// sonst verwendet. `filter` matcht als Teilstring/ILIKE, nicht exakt (z.B.
// "qa.admin" trifft auch "qa.admin.20260805@..."), deshalb wird hier IMMER
// hart auf exakte Gleichheit nachgeprüft statt der erste Treffer ungeprüft
// übernommen.
async function findExistingAuthUserByEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
): Promise<AuthUserLookup | null> {
  const url = `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`;
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Auth-Lookup fehlgeschlagen (Status ${response.status}).`);
  }

  const body = (await response.json()) as { users?: AuthUserLookup[] };
  const users = body.users ?? [];
  return users.find((u) => u.email?.toLowerCase() === email) ?? null;
}

type ProfileConflictCheck = {
  company_id: string | null;
  invite_accepted_at: string | null;
} | null;

// Dieselbe Konflikt-Regel wird zweimal angewendet: VOR inviteUserByEmail
// (verhindert im Normalfall den Einladungs-Mail-Seiteneffekt für abgelehnte
// Anfragen) und NACH inviteUserByEmail (Race-Absicherung — zwei praktisch
// gleichzeitige Requests für dieselbe, wirklich neue E-Mail können die
// Vorab-Prüfung beide passieren, siehe Kommentar unten am zweiten
// Aufrufort). Kein echtes Profil (null) oder ein Trigger-Stub
// (company_id = null, siehe handle_new_user()) ist nie ein Konflikt — eine
// Auth-Identität, die noch bei KEINER Firma Mitglied ist, darf frei
// eingeladen werden.
//
// Architektur-Hinweis (nicht in B4 aufgelöst): "existiert dieselbe Person
// schon woanders" und "gehört diese Mitgliedschaft schon einer anderen
// Firma" sind hier bewusst DIESELBE Prüfung, weil `profiles.company_id`
// eine EINZELNE Spalte ist — eine Auth-Identität hat maximal eine
// Mitgliedschaft gleichzeitig abbildbar. Diese Funktion sperrt NICHT "eine
// Person darf nur bei einer Firma je existieren" als Geschäftsregel; sie
// verhindert nur, dass ein Invite die EINZIGE vorhandene Mitgliedschaftszeile
// eines fremden/bereits akzeptierten Mitarbeiters überschreibt — bei einer
// Spalte gibt es dafür keinen sicheren "daneben"-Fall, nur "überschreiben"
// oder "ablehnen". Sollte Mehrfirmen-Beschäftigung künftig ein echtes
// Produktfeature werden, braucht das eine eigene Datenmodell-Änderung (z.B.
// eine company_memberships-Tabelle statt einer Spalte) — diese Funktion
// müsste dann pro Mitgliedschaft statt pro Profil prüfen. Absichtlich nicht
// in B4 vorweggenommen.
function isConflictingProfile(
  profile: ProfileConflictCheck,
  adminCompanyId: string,
): boolean {
  if (!profile || profile.company_id === null) return false;
  const sameCompany = profile.company_id === adminCompanyId;
  const alreadyAccepted = !!profile.invite_accepted_at;
  return !sameCompany || alreadyAccepted;
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
    // Optional: ungültige/leere Nummer wird still verworfen (kein harter Fehler
    // — der Mitarbeiter kann die Nummer später selbst im Profil setzen).
    const phone = normalizePhoneE164(body.phone);

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

    // ── Pre-Invite-Prüfung ──────────────────────────────────────────────
    // Lehnt bekannte Konflikte AB, BEVOR inviteUserByEmail aufgerufen wird —
    // eine Anfrage, die ohnehin abgelehnt wird, soll im Normalfall keine
    // echte Einladungs-Mail an eine fremde/bereits aktive Adresse auslösen.
    // Nur wenn KEIN Auth-Nutzer für diese E-Mail existiert ODER er zwar
    // existiert, aber (noch) kein echtes Profil bei irgendeiner Firma hat
    // (Trigger-Stub, company_id = null), läuft die Anfrage ungehindert
    // weiter. Der Post-Invite-Guard unten bleibt zusätzlich bestehen — er
    // sichert den seltenen Race-Fall ab (siehe dortiger Kommentar), auf den
    // sich diese Vorab-Prüfung allein nicht verlassen kann.
    let preInviteAuthUser: AuthUserLookup | null = null;
    try {
      preInviteAuthUser = await findExistingAuthUserByEmail(
        supabaseUrl,
        serviceRoleKey,
        email,
      );
    } catch {
      return Response.json(
        { error: "E-Mail-Adresse konnte nicht geprüft werden." },
        { status: 500, headers: corsHeaders },
      );
    }

    if (preInviteAuthUser) {
      const { data: preInviteProfile, error: preInviteProfileError } =
        await adminClient
          .from("profiles")
          .select("company_id, invite_accepted_at")
          .eq("id", preInviteAuthUser.id)
          .maybeSingle();

      if (preInviteProfileError) {
        return Response.json(
          { error: "Mitarbeiter-Profil konnte nicht geprüft werden." },
          { status: 500, headers: corsHeaders },
        );
      }

      if (isConflictingProfile(preInviteProfile, adminProfile.company_id)) {
        return Response.json(
          {
            error: "Für diese E-Mail-Adresse existiert bereits ein Konto.",
            code: "email_exists",
          },
          { status: 409, headers: corsHeaders },
        );
      }
    }

    // Einladung statt admin-vergebenem Passwort: legt den Nutzer unbestätigt
    // an und verschickt Supabase's Invite-Mail mit einem einmalig gültigen
    // Link. Der Mitarbeiter setzt sein Passwort selbst (accept-invite-Screen,
    // supabase.auth.updateUser). Kein Passwort verlässt je den Admin-Client
    // oder diese Function.
    const { data: invitedUser, error: inviteError } =
      await adminClient.auth.admin.inviteUserByEmail(email, {
        data: {
          full_name: fullName,
        },
        redirectTo: INVITE_REDIRECT_TO,
      });

    if (inviteError || !invitedUser.user) {
      return Response.json(
        {
          error:
            inviteError?.message ?? "Einladung konnte nicht verschickt werden.",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const employeeId = invitedUser.user.id;
    const invitedAt = new Date().toISOString();

    // ── Post-Invite-Guard (Race-Absicherung) ─────────────────────────────
    // Bleibt trotz der Vorab-Prüfung oben bestehen: zwei praktisch
    // gleichzeitige create-employee-Aufrufe für dieselbe, wirklich neue
    // E-Mail (z.B. von zwei verschiedenen Firmen-Admins) können BEIDE die
    // Vorab-Prüfung mit "kein Konflikt" passieren, bevor einer von beiden
    // inviteUserByEmail/den Upsert abgeschlossen hat — GoTrue liefert dann
    // beiden dieselbe employeeId zurück (E-Mail ist eindeutig in
    // auth.users). Dieser zweite, unabhängige Check nach dem tatsächlichen
    // Ergebnis von inviteUserByEmail ist die einzige Stelle, die diesen
    // Fall zuverlässig abfängt: wer zuerst upserted, "gewinnt" die
    // Firmenzuordnung; der andere sieht hier einen echten Konflikt und wird
    // abgelehnt, BEVOR sein eigener Upsert die Zeile erneut anfasst.
    //
    // inviteUserByEmail matcht per E-Mail und liefert bei einer bereits
    // existierenden Auth-Identität (bestätigt ODER unbestätigt) dieselbe
    // employeeId zurück — nicht zwingend einen neuen Nutzer. Ohne diese
    // Prüfung würde der Upsert unten das zugehörige profiles-Zeile blind
    // überschreiben: is_active könnte einen deaktivierten Mitarbeiter
    // reaktivieren, company_id könnte ihn firmenübergreifend umhängen.
    //
    // Wichtig: der on_auth_user_created-Trigger (handle_new_user(), siehe
    // 20260826000000_backfill_on_auth_user_created_trigger.sql) legt bei
    // JEDEM neuen auth.users-Insert — auch dem, den inviteUserByEmail gerade
    // für einen wirklich neuen Nutzer ausgelöst hat — sofort eine Stub-Zeile
    // in profiles an (nur id + full_name, company_id bleibt null). Eine
    // existierende profiles-Zeile ist daher kein zuverlässiges Signal für
    // "schon eingeladen" — isConflictingProfile() behandelt einen Stub
    // (company_id = null) korrekt wie "kein Profil".
    const { data: existingProfile, error: existingProfileError } =
      await adminClient
        .from("profiles")
        .select("company_id, invite_accepted_at")
        .eq("id", employeeId)
        .maybeSingle();

    if (existingProfileError) {
      return Response.json(
        { error: "Mitarbeiter-Profil konnte nicht geprüft werden." },
        { status: 500, headers: corsHeaders },
      );
    }

    if (isConflictingProfile(existingProfile, adminProfile.company_id)) {
      return Response.json(
        {
          error: "Für diese E-Mail-Adresse existiert bereits ein Konto.",
          code: "email_exists",
        },
        { status: 409, headers: corsHeaders },
      );
    }
    // Kein Konflikt: entweder ein wirklich neuer Nutzer, ein Stub ohne
    // Firma, oder eine offene Einladung DERSELBEN Firma (Upsert unten
    // verhält sich dann wie ein erneutes Senden).

    const { error: upsertProfileError } = await adminClient
      .from("profiles")
      .upsert({
        id: employeeId,
        full_name: fullName,
        role: "employee",
        company_id: adminProfile.company_id,
        is_active: true,
        invited_at: invitedAt,
        // Nur setzen, wenn eine gültige Nummer übergeben wurde — sonst NICHT
        // in den Upsert aufnehmen (ein erneutes Senden ohne Nummer soll eine
        // vorhandene Nummer nicht löschen).
        ...(phone ? { phone } : {}),
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
          invitedAt,
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