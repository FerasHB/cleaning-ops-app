// =========================================================
// TEST: Firmengrenze der Service-Role-Functions create-employee + resend-invite
// =========================================================
// Beide Functions laufen mit verify_jwt = false (supabase/config.toml) und
// nutzen den Service-Role-Client, umgehen also RLS. Die Firmengrenze muss
// deshalb IN der Function halten:
//   * create-employee: Admin ohne Firma -> 400 vor jedem Lookup/Versand;
//     E-Mail eines (angenommenen ODER offenen) Mitarbeiters einer FREMDEN
//     Firma -> 409, kein Invite, kein Profil-Schreibzugriff; Firma/Rolle des
//     neuen Profils kommen aus dem Admin-Profil, nie aus dem Body.
//   * resend-invite: Ziel einer fremden Firma / Ziel ist kein Mitarbeiter ->
//     403, unbekanntes Ziel -> 404, jeweils ohne Auth-Admin-Lookup und ohne
//     Versand; E-Mail kommt aus auth.users, nie aus dem Body.
// Fehlende/ungültige Session, Nicht-Admin und deaktivierter Admin deckt
// deactivated_admin_guard.test.ts ab.
//
// Verhaltenstest gegen die UNVERÄNDERTEN index.ts-Module (Deno.serve wird
// abgefangen). globalThis.fetch simuliert GoTrue + PostgREST; kein Netzwerk,
// kein Mailversand.
//
// AUSFÜHREN:
//   deno test --no-config --allow-env --deny-net supabase/functions/tests/invite_company_boundary.test.ts

import { assertEquals } from "jsr:@std/assert@1";

const SUPABASE_URL = "http://supabase.test";
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const COMPANY_A = "c0000000-0000-0000-0000-00000000000a";
const COMPANY_B = "c0000000-0000-0000-0000-00000000000b";

type Profile = {
  id: string;
  role: "admin" | "employee";
  company_id: string | null;
  is_active: boolean;
  full_name: string;
  invite_accepted_at: string | null;
};

const U_ADMIN_A = "a0000000-0000-0000-0000-00000000000a";
const U_ADMIN_NO_COMPANY = "a0000000-0000-0000-0000-0000000000ff";
const U_ADMIN_A2 = "a0000000-0000-0000-0000-0000000000a2";
const U_EMP_A_PENDING = "e0000000-0000-0000-0000-0000000000a1";
const U_EMP_B_ACCEPTED = "e0000000-0000-0000-0000-0000000000b1";
const U_EMP_B_PENDING = "e0000000-0000-0000-0000-0000000000b2";
const U_NEW = "e0000000-0000-0000-0000-000000000001";

const PROFILES: Record<string, Profile> = {
  [U_ADMIN_A]: { id: U_ADMIN_A, role: "admin", company_id: COMPANY_A, is_active: true, full_name: "Admin A", invite_accepted_at: null },
  [U_ADMIN_A2]: { id: U_ADMIN_A2, role: "admin", company_id: COMPANY_A, is_active: true, full_name: "Admin A2", invite_accepted_at: null },
  [U_ADMIN_NO_COMPANY]: { id: U_ADMIN_NO_COMPANY, role: "admin", company_id: null, is_active: true, full_name: "Admin ohne Firma", invite_accepted_at: null },
  [U_EMP_A_PENDING]: { id: U_EMP_A_PENDING, role: "employee", company_id: COMPANY_A, is_active: true, full_name: "Emp A", invite_accepted_at: null },
  [U_EMP_B_ACCEPTED]: { id: U_EMP_B_ACCEPTED, role: "employee", company_id: COMPANY_B, is_active: true, full_name: "Emp B", invite_accepted_at: "2026-01-02T00:00:00Z" },
  [U_EMP_B_PENDING]: { id: U_EMP_B_PENDING, role: "employee", company_id: COMPANY_B, is_active: true, full_name: "Emp B2", invite_accepted_at: null },
};
const EMAILS: Record<string, string> = {
  [U_EMP_A_PENDING]: "emp.a@example.test",
  [U_EMP_B_ACCEPTED]: "emp.b@example.test",
  [U_EMP_B_PENDING]: "emp.b2@example.test",
};
const TOKENS: Record<string, string> = {
  "tok-admin-a": U_ADMIN_A,
  "tok-admin-no-company": U_ADMIN_NO_COMPANY,
};

type Call = { method: string; path: string; search: string; body: unknown };
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authUser(id: string) {
  return {
    id, aud: "authenticated", role: "authenticated", email: EMAILS[id] ?? `${id}@example.test`,
    app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
    confirmed_at: null, email_confirmed_at: null,
  };
}

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const text = req.method === "GET" ? "" : await req.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  calls.push({ method: req.method, path: url.pathname, search: url.search, body });

  if (url.pathname === "/auth/v1/user") {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = TOKENS[token];
    if (!userId) return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
    return json(authUser(userId));
  }

  // create-employee: gebundene Suche per ?filter=<email>
  if (url.pathname === "/auth/v1/admin/users" && req.method === "GET") {
    const filter = (url.searchParams.get("filter") ?? "").toLowerCase();
    const users = Object.entries(EMAILS)
      .filter(([, email]) => email.includes(filter))
      .map(([id, email]) => ({ id, email }));
    return json({ users });
  }

  if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "GET") {
    const id = url.pathname.split("/").pop()!;
    if (!EMAILS[id]) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    return json(authUser(id));
  }

  if (url.pathname === "/auth/v1/invite" && req.method === "POST") {
    const email = (body as { email: string }).email;
    const existing = Object.entries(EMAILS).find(([, e]) => e === email)?.[0];
    return json(authUser(existing ?? U_NEW));
  }

  if (url.pathname === "/rest/v1/profiles") {
    if (req.method !== "GET") return json(null, 201);
    const select = url.searchParams.get("select") ?? "*";
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    const profile = PROFILES[id];
    const columns = select.split(",").map((c) => c.trim());
    const projected = profile
      ? Object.fromEntries(columns.filter((c) => c in profile).map((c) => [c, profile[c as keyof Profile]]))
      : null;
    // single() fordert ein Objekt an, maybeSingle() ein Array.
    if ((req.headers.get("Accept") ?? "").includes("vnd.pgrst.object")) {
      return projected
        ? json(projected)
        : json({ code: "PGRST116", details: "0 rows", hint: null, message: "no rows" }, 406);
    }
    return json(projected ? [projected] : []);
  }

  return json({ message: `unexpected call ${req.method} ${url.pathname}` }, 500);
};

type Handler = (req: Request) => Response | Promise<Response>;

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

const createEmployee = await loadHandler("create-employee", () => import("../create-employee/index.ts"));
const resendInvite = await loadHandler("resend-invite", () => import("../resend-invite/index.ts"));

async function call(handler: Handler, token: string, body: unknown) {
  calls = [];
  const res = await handler(new Request(`${SUPABASE_URL}/functions/v1/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const invites = () => calls.filter((c) => c.path === "/auth/v1/invite");
const recovers = () => calls.filter((c) => c.path === "/auth/v1/recover");
const profileWrites = () => calls.filter((c) => c.path === "/rest/v1/profiles" && c.method !== "GET");
const adminLookups = () => calls.filter((c) => c.path.startsWith("/auth/v1/admin/"));

// ── create-employee ──────────────────────────────────────────────────

Deno.test("create-employee: Admin ohne Firma -> 400 vor Lookup/Invite/Schreibzugriff", async () => {
  const r = await call(createEmployee, "tok-admin-no-company", { fullName: "X", email: "neu@example.test" });
  assertEquals(r.status, 400);
  assertEquals(r.body.error, "Admin hat keine company_id.");
  assertEquals(adminLookups(), []);
  assertEquals(invites(), []);
  assertEquals(profileWrites(), []);
});

for (const [label, email] of [
  ["angenommener", "emp.b@example.test"],
  ["offen eingeladener", "emp.b2@example.test"],
] as const) {
  Deno.test(`create-employee: ${label} Mitarbeiter einer fremden Firma -> 409, kein Invite, kein Schreibzugriff`, async () => {
    const r = await call(createEmployee, "tok-admin-a", { fullName: "Übernahme", email: email.toUpperCase() });
    assertEquals(r.status, 409);
    assertEquals(r.body.code, "email_exists");
    assertEquals(invites(), []);
    assertEquals(profileWrites(), []);
  });
}

Deno.test("create-employee: neuer Mitarbeiter bekommt Firma + Rolle aus dem Admin-Profil, nie aus dem Body", async () => {
  const r = await call(createEmployee, "tok-admin-a", {
    fullName: "Neu",
    email: "neu@example.test",
    company_id: COMPANY_B,
    role: "admin",
  });
  assertEquals(r.status, 200);
  assertEquals(invites().length, 1);
  const writes = profileWrites();
  assertEquals(writes.length, 1);
  const row = writes[0].body as Record<string, unknown>;
  assertEquals([row.id, row.company_id, row.role, row.is_active], [U_NEW, COMPANY_A, "employee", true]);
});

// ── resend-invite ────────────────────────────────────────────────────

Deno.test("resend-invite: Mitarbeiter einer fremden Firma -> 403, kein Lookup, kein Versand", async () => {
  const r = await call(resendInvite, "tok-admin-a", { employeeId: U_EMP_B_PENDING });
  assertEquals(r.status, 403);
  assertEquals(r.body.error, "Nicht erlaubt.");
  assertEquals(adminLookups(), []);
  assertEquals(invites(), []);
  assertEquals(recovers(), []);
  assertEquals(profileWrites(), []);
});

Deno.test("resend-invite: Ziel ist Admin derselben Firma -> 403, kein Versand", async () => {
  const r = await call(resendInvite, "tok-admin-a", { employeeId: U_ADMIN_A2 });
  assertEquals(r.status, 403);
  assertEquals(adminLookups(), []);
  assertEquals(invites(), []);
});

Deno.test("resend-invite: unbekanntes Ziel -> 404, kein Versand", async () => {
  const r = await call(resendInvite, "tok-admin-a", { employeeId: "e0000000-0000-0000-0000-00000000dead" });
  assertEquals(r.status, 404);
  assertEquals(adminLookups(), []);
  assertEquals(invites(), []);
});

Deno.test("resend-invite: eigener offener Mitarbeiter -> Invite an die auth.users-E-Mail, nicht an den Body", async () => {
  const r = await call(resendInvite, "tok-admin-a", {
    employeeId: U_EMP_A_PENDING,
    email: "angreifer@example.test",
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.mode, "invite");
  assertEquals(invites().map((c) => (c.body as { email: string }).email), ["emp.a@example.test"]);
  const writes = profileWrites();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].search.includes(`id=eq.${U_EMP_A_PENDING}`), true);
});
