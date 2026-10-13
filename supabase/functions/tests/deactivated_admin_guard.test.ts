// =========================================================
// TEST: Deaktivierte Admins vs. Service-Role-Edge-Functions
// (create-employee, resend-invite)
// =========================================================
// Beide Functions laufen mit dem Service-Role-Client und umgehen damit RLS.
// Ein deaktivierter Admin (profiles.is_active = false) muss deshalb in der
// Function selbst mit 403 abgewiesen werden. Alle übrigen Pfade (aktiver
// Admin, Nicht-Admin, fehlendes Profil, fehlende/ungültige Session) bleiben
// unverändert.
//
// Verhaltenstest gegen die UNVERÄNDERTEN index.ts-Module: Deno.serve wird
// abgefangen, um den Handler zu erhalten, und globalThis.fetch simuliert
// Supabase Auth (/auth/v1/user) und PostgREST (/rest/v1/profiles). Der
// PostgREST-Stub liefert nur die per `select` angeforderten Spalten — fehlt
// is_active in der Abfrage, schlägt der Fall "aktiver Admin" fehl.
// Kein Netzwerk, keine echte Supabase-Verbindung, kein Mailversand: jeder
// geprüfte Pfad endet vor dem Einladungsversand.
//
// AUSFÜHREN:
//   deno test --allow-env supabase/functions/tests/deactivated_admin_guard.test.ts

import { assertEquals } from "jsr:@std/assert@1";

const SUPABASE_URL = "http://supabase.test";
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

type Profile = {
  id: string;
  role: "admin" | "employee";
  company_id: string | null;
  is_active: boolean;
};

const COMPANY = "c0000000-0000-0000-0000-000000000001";
const PROFILES: Record<string, Profile> = {
  "u-admin-active":   { id: "u-admin-active",   role: "admin",    company_id: COMPANY, is_active: true },
  "u-admin-inactive": { id: "u-admin-inactive", role: "admin",    company_id: COMPANY, is_active: false },
  "u-employee":       { id: "u-employee",       role: "employee", company_id: COMPANY, is_active: true },
};
// Bearer-Token -> User-ID ("u-no-profile" hat eine Session, aber kein Profil).
const TOKENS: Record<string, string> = {
  "tok-admin-active": "u-admin-active",
  "tok-admin-inactive": "u-admin-inactive",
  "tok-employee": "u-employee",
  "tok-no-profile": "u-no-profile",
};

const profileSelects: string[] = [];
const unexpectedCalls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);

  if (url.pathname === "/auth/v1/user") {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = TOKENS[token];
    if (!userId) {
      return Promise.resolve(json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401));
    }
    return Promise.resolve(json({
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId}@example.test`,
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    }));
  }

  if (url.pathname === "/rest/v1/profiles") {
    const select = url.searchParams.get("select") ?? "*";
    profileSelects.push(select);
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    const profile = PROFILES[id];
    if (!profile) {
      return Promise.resolve(json({
        code: "PGRST116",
        details: "The result contains 0 rows",
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      }, 406));
    }
    const columns = select.split(",").map((c) => c.trim());
    const projected = Object.fromEntries(
      columns.filter((c) => c in profile).map((c) => [c, profile[c as keyof Profile]]),
    );
    return Promise.resolve(json(projected));
  }

  unexpectedCalls.push(`${req.method} ${url.pathname}`);
  return Promise.resolve(json({ message: "unexpected call in test" }, 500));
};

type Handler = (req: Request) => Response | Promise<Response>;

// Module werden NACHEINANDER geladen (Deno.serve wird je Import ersetzt und
// wiederhergestellt); literale import()-Pfade, damit Deno sie statisch kennt.
async function loadHandler(name: string, load: () => Promise<unknown>): Promise<Handler> {
  let captured: Handler | undefined;
  const originalServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (handler: Handler) => {
    captured = handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
  };
  try {
    await load();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = originalServe;
  }
  if (!captured) throw new Error(`Deno.serve wurde von ${name} nicht aufgerufen`);
  return captured;
}

async function call(handler: Handler, token: string | null, body: unknown = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await handler(new Request(`${SUPABASE_URL}/functions/v1/test`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as { error?: string } };
}

const FUNCTIONS = [
  {
    name: "create-employee",
    load: () => import("../create-employee/index.ts"),
    nonAdminError: "Nur Admins dürfen Mitarbeiter erstellen.",
    // Leerer Body: aktiver Admin passiert alle Berechtigungsprüfungen und
    // endet an der bestehenden Eingabevalidierung (400), vor jedem Versand.
    passedGuardStatus: 400,
  },
  {
    name: "resend-invite",
    load: () => import("../resend-invite/index.ts"),
    nonAdminError: "Nur Admins dürfen Einladungen erneut senden.",
    passedGuardStatus: 400,
  },
];

const handlers = new Map<string, Handler>();
for (const fn of FUNCTIONS) {
  handlers.set(fn.name, await loadHandler(fn.name, fn.load));
}

for (const fn of FUNCTIONS) {
  const handlerPromise = Promise.resolve(handlers.get(fn.name)!);

  Deno.test(`${fn.name}: deaktivierter Admin -> 403 "Admin-Konto ist deaktiviert."`, async () => {
    const res = await call(await handlerPromise, "tok-admin-inactive");
    assertEquals(res.status, 403);
    assertEquals(res.body.error, "Admin-Konto ist deaktiviert.");
  });

  Deno.test(`${fn.name}: aktiver Admin passiert die Berechtigungsprüfung unverändert`, async () => {
    const res = await call(await handlerPromise, "tok-admin-active");
    assertEquals(res.status, fn.passedGuardStatus);
    assertEquals(res.body.error === "Admin-Konto ist deaktiviert.", false);
    assertEquals(profileSelects.at(-1)?.split(",").includes("is_active"), true);
  });

  Deno.test(`${fn.name}: Nicht-Admin -> unverändert 403 mit Rollen-Meldung`, async () => {
    const res = await call(await handlerPromise, "tok-employee");
    assertEquals(res.status, 403);
    assertEquals(res.body.error, fn.nonAdminError);
  });

  Deno.test(`${fn.name}: fehlendes Admin-Profil -> unverändert 403`, async () => {
    const res = await call(await handlerPromise, "tok-no-profile");
    assertEquals(res.status, 403);
    assertEquals(res.body.error, "Admin-Profil konnte nicht geladen werden.");
  });

  Deno.test(`${fn.name}: ungültige Session -> unverändert 401`, async () => {
    const res = await call(await handlerPromise, "tok-unknown");
    assertEquals(res.status, 401);
    assertEquals(res.body.error, "Ungültige Session.");
  });

  Deno.test(`${fn.name}: kein Authorization-Header -> unverändert 401`, async () => {
    const res = await call(await handlerPromise, null);
    assertEquals(res.status, 401);
    assertEquals(res.body.error, "Nicht eingeloggt.");
  });
}

Deno.test("keine unerwarteten Netzwerkaufrufe (kein Invite-/Mailversand)", () => {
  assertEquals(unexpectedCalls, []);
});
