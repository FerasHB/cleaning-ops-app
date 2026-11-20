// =========================================================
// TEST: dispatch-notifications — Aufrufmodi + Autorisierung
// =========================================================
// verify_jwt = false (supabase/config.toml): die Function entscheidet selbst,
// ob ein Aufruf als SERVER-Sweep (alle Firmen, company_id_filter = null) oder
// als CLIENT-Kick (nur die Firma des aktiven Aufrufers) läuft. Geprüft wird,
// dass
//   * ohne Header / mit ungültiger Session / mit fehlendem, inaktivem oder
//     firmenlosem Profil KEINE RPC läuft (401/403),
//   * ein CLIENT-Kick immer auf die Firma des Profils gescopt ist (Body und
//     Header können das nicht überschreiben),
//   * SERVER-Modus nur mit exakt passendem Sweeper-Secret oder exakt
//     "Bearer <service_role>" erreicht wird (QA-9: konstantzeit verglichen).
// Kein Netzwerk: globalThis.fetch simuliert GoTrue + PostgREST.
//
// AUSFÜHREN:
//   deno test --no-config --allow-env --allow-read=supabase/functions --deny-net \
//     supabase/functions/dispatch-notifications/auth.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const SERVICE_ROLE = "test-service-role-key";
const SWEEPER = "sweeper-secret";
Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
Deno.env.set("DISPATCH_SWEEPER_SECRET", SWEEPER);

const { handleRequest } = await import("./index.ts");

const COMPANY_A = "c0000000-0000-0000-0000-00000000000a";
const COMPANY_B = "c0000000-0000-0000-0000-00000000000b";

type Profile = { company_id: string | null; is_active: boolean };
const PROFILES: Record<string, Profile> = {
  "u-active": { company_id: COMPANY_A, is_active: true },
  "u-inactive": { company_id: COMPANY_A, is_active: false },
  "u-no-company": { company_id: null, is_active: true },
};
const TOKENS: Record<string, string> = {
  "tok-active": "u-active",
  "tok-inactive": "u-inactive",
  "tok-no-company": "u-no-company",
  "tok-no-profile": "u-no-profile",
};

type Rpc = { name: string; body: Record<string, unknown> };
let rpcs: Rpc[] = [];
let userLookups = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.pathname === "/auth/v1/user") {
    userLookups++;
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = TOKENS[token];
    if (!userId) return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
    return json({
      id: userId, aud: "authenticated", role: "authenticated", email: `${userId}@example.test`,
      app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
    });
  }
  if (url.pathname === "/rest/v1/profiles") {
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    const p = PROFILES[id];
    return p ? json(p) : json({ code: "PGRST116", details: "0 rows", hint: null, message: "no rows" }, 406);
  }
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const name = url.pathname.slice("/rest/v1/rpc/".length);
    rpcs.push({ name, body: await req.json() });
    if (name === "fanout_notification_events") return json(0);
    if (name === "claim_notification_deliveries") return json([]);
  }
  return json({ message: `unexpected call ${req.method} ${url.pathname}` }, 500);
};

async function call(headers: Record<string, string>, body: unknown = {}) {
  rpcs = [];
  userLookups = 0;
  const res = await handleRequest(new Request("http://fn.test/dispatch-notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const fanoutFilters = () =>
  rpcs.filter((r) => r.name === "fanout_notification_events").map((r) => r.body.company_id_filter);

// ── Abgelehnte Aufrufe: keine einzige RPC ───────────────────────────────

Deno.test("ohne Authorization und ohne Sweeper-Secret -> 401, keine RPC", async () => {
  const r = await call({});
  assertEquals(r.status, 401);
  assertEquals(rpcs, []);
});

Deno.test("ungültige/fremde Session -> 401, keine RPC", async () => {
  for (const token of ["tok-unknown", "test-anon-key", SWEEPER]) {
    const r = await call({ Authorization: `Bearer ${token}` });
    assertEquals(r.status, 401, token);
    assertEquals(rpcs, []);
  }
});

for (const [token, label] of [
  ["tok-inactive", "deaktiviertes Profil"],
  ["tok-no-company", "Profil ohne Firma"],
  ["tok-no-profile", "fehlendes Profil"],
] as const) {
  Deno.test(`${label} -> 403, keine RPC`, async () => {
    const r = await call({ Authorization: `Bearer ${token}` });
    assertEquals(r.status, 403);
    assertEquals(rpcs, []);
  });
}

Deno.test("falsches Sweeper-Secret (gleiche Länge, Präfix, leer) ohne Session -> 401, keine RPC", async () => {
  for (const wrong of ["sweeper-secreT", "sweeper-secre", `${SWEEPER}x`, ""]) {
    const r = await call({ "x-sweeper-secret": wrong });
    assertEquals(r.status, 401, wrong);
    assertEquals(rpcs, []);
  }
});

// ── CLIENT-Modus: immer auf die eigene Firma gescopt ────────────────────

Deno.test("aktiver Nutzer -> nur eigene Firma, Body-Firma wird ignoriert", async () => {
  const r = await call({ Authorization: "Bearer tok-active" }, { company_id_filter: COMPANY_B, company_id: COMPANY_B });
  assertEquals(r.status, 200);
  assertEquals(fanoutFilters(), [COMPANY_A]);
  assert(rpcs.every((x) => x.body.company_id_filter === COMPANY_A));
});

Deno.test("aktiver Nutzer + falsches Sweeper-Secret -> bleibt CLIENT-Modus (eigene Firma)", async () => {
  const r = await call({ Authorization: "Bearer tok-active", "x-sweeper-secret": "nope" });
  assertEquals(r.status, 200);
  assertEquals(fanoutFilters(), [COMPANY_A]);
});

// ── SERVER-Modus: nur mit exakt passendem Secret ────────────────────────

Deno.test("korrektes Sweeper-Secret -> SERVER-Modus (alle Firmen), keine Session-Prüfung", async () => {
  const r = await call({ "x-sweeper-secret": SWEEPER });
  assertEquals(r.status, 200);
  assertEquals(fanoutFilters(), [null]);
  assertEquals(userLookups, 0);
});

Deno.test("exakt 'Bearer <service_role>' -> SERVER-Modus (rückwärtskompatibel)", async () => {
  const r = await call({ Authorization: `Bearer ${SERVICE_ROLE}` });
  assertEquals(r.status, 200);
  assertEquals(fanoutFilters(), [null]);
  assertEquals(userLookups, 0);
});

Deno.test("Beinahe-Treffer des Service-Role-Bearers -> kein SERVER-Modus (401 über Session-Prüfung)", async () => {
  for (const header of [
    `Bearer ${SERVICE_ROLE.slice(0, -1)}X`, // gleiche Länge, letztes Zeichen anders
    `Bearer ${SERVICE_ROLE.slice(0, -1)}`, // Präfix
    `Bearer ${SERVICE_ROLE}x`, // Suffix (Leerzeichen am Ende trimmt die Fetch-API selbst)
    `bearer ${SERVICE_ROLE}`, // Schema-Schreibweise: bisher strikt, bleibt strikt
    SERVICE_ROLE, // ohne Schema
  ]) {
    const r = await call({ Authorization: header });
    assertEquals(r.status, 401, header);
    assertEquals(rpcs, []);
  }
});

Deno.test("Sweeper-Secret nicht konfiguriert -> Header wird ignoriert (401)", async () => {
  Deno.env.delete("DISPATCH_SWEEPER_SECRET");
  try {
    const r = await call({ "x-sweeper-secret": SWEEPER });
    assertEquals(r.status, 401);
    assertEquals(rpcs, []);
  } finally {
    Deno.env.set("DISPATCH_SWEEPER_SECRET", SWEEPER);
  }
});

// QA-9: der Service-Role-Bearer darf nicht per `===` verglichen werden.
Deno.test("QA-9: Service-Role-Bearer wird konstantzeit verglichen (kein ===)", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(/(===|!==)\s*`Bearer \$\{serviceRoleKey\}`/.test(source), false);
  assertEquals(/`Bearer \$\{serviceRoleKey\}`\s*(===|!==)/.test(source), false);
  assert(source.includes("timingSafeEqual(authHeader, `Bearer ${serviceRoleKey}`)"));
});
