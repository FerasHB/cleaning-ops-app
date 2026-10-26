// =========================================================
// TEST: Edge Function delete-account (Store-Compliance, Migration
// 20261026000000)
// =========================================================
// Verhaltenstest gegen das UNVERÄNDERTE index.ts-Modul: Deno.serve wird
// abgefangen, globalThis.fetch simuliert Supabase Auth, PostgREST (Profile +
// RPCs) und die Storage-API. Die Datenbank-Seite (Rollen-/Firmenprüfung,
// Kaskade, Snapshots) deckt supabase/tests/store_compliance_account_deletion
// .test.sql ab — hier geht es um die Function-Logik:
//   * Identität kommt IMMER aus der Session, nie aus dem Body
//   * ohne Bestätigung nie Firmenlöschung (409 last_admin)
//   * mit Bestätigung: Purge-RPC mit Session-ID + Storage-Aufräumen
//   * RPC-Ablehnungen (fremde Firma, weiterer Admin) löschen nichts
//   * wiederholter Aufruf nach erfolgreicher Löschung: 401, kein Effekt
//
// AUSFÜHREN:
//   deno test --allow-env supabase/functions/tests/delete_account.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const SUPABASE_URL = "http://supabase.test";
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const COMPANY_A = "c0000000-0000-0000-0000-00000000000a";
const COMPANY_B = "c0000000-0000-0000-0000-00000000000b";

const U_EMPLOYEE = "a0000000-0000-0000-0000-000000000001";
const U_SOLO_ADMIN = "a0000000-0000-0000-0000-000000000002";
const U_DUO_ADMIN = "a0000000-0000-0000-0000-000000000003";

type Profile = { id: string; role: "admin" | "employee"; company_id: string };
// u-solo-admin: einziger Admin von A; u-duo-admin: Admin von B mit Kollege.
const PROFILES: Record<string, Profile> = {
  [U_EMPLOYEE]: { id: U_EMPLOYEE, role: "employee", company_id: COMPANY_B },
  [U_SOLO_ADMIN]: { id: U_SOLO_ADMIN, role: "admin", company_id: COMPANY_A },
  [U_DUO_ADMIN]: { id: U_DUO_ADMIN, role: "admin", company_id: COMPANY_B },
};
const TOKENS: Record<string, string> = {
  "tok-employee": U_EMPLOYEE,
  "tok-solo-admin": U_SOLO_ADMIN,
  "tok-duo-admin": U_DUO_ADMIN,
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
const deletedUsers = new Set<string>();
let storageFails = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pgError(message: string): Response {
  return json({ code: "P0001", details: null, hint: null, message }, 400);
}

// Simuliert die Server-Prädikate der RPCs (Details: SQL-Test).
function isLastAdmin(userId: string): boolean {
  const p = PROFILES[userId];
  return p?.role === "admin" && p.company_id === COMPANY_A;
}

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const text = req.method === "GET" ? "" : await req.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  calls.push({ method: req.method, path: url.pathname, body });

  if (url.pathname === "/auth/v1/user") {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = TOKENS[token];
    if (!userId || deletedUsers.has(userId)) {
      return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
    }
    return json({
      id: userId, aud: "authenticated", role: "authenticated",
      email: `${userId}@example.test`, app_metadata: {}, user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    });
  }

  if (url.pathname === "/rest/v1/profiles") {
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    if (!PROFILES[id] || deletedUsers.has(id)) {
      return json({ code: "PGRST116", details: "0 rows", hint: null, message: "no rows" }, 406);
    }
    return json({ id });
  }

  if (url.pathname === "/rest/v1/rpc/recover_stale_account_deletion_reservations") {
    return json(null);
  }

  if (url.pathname === "/rest/v1/rpc/prepare_self_account_deletion") {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = TOKENS[token];
    return isLastAdmin(userId) ? pgError("last_admin") : json("11111111-1111-1111-1111-111111111111");
  }

  if (url.pathname === "/rest/v1/rpc/purge_company_for_last_admin") {
    const args = body as { p_caller: string; p_confirm_company_id: string };
    const p = PROFILES[args.p_caller];
    if (!p) return pgError("profile_not_found");
    if (p.role !== "admin") return pgError("not_admin");
    if (args.p_confirm_company_id !== p.company_id) return pgError("company_mismatch");
    if (!isLastAdmin(args.p_caller)) return pgError("not_last_admin");
    deletedUsers.add(args.p_caller);
    return json({
      company_id: p.company_id,
      deleted_user_ids: [args.p_caller],
      storage_paths: [`${p.company_id}/job-1/reported.jpg`],
      retained_record_count: 3,
    });
  }

  if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "DELETE") {
    deletedUsers.add(url.pathname.split("/").pop()!);
    return json({});
  }

  if (url.pathname === "/storage/v1/object/list/job-photos") {
    if (storageFails) return json({ statusCode: "500", error: "boom", message: "boom" }, 500);
    const prefix = (body as { prefix: string }).prefix;
    if (prefix === COMPANY_A) {
      return json([{ name: "job-1", id: null }, { name: "job-2", id: null }]);
    }
    if (prefix === `${COMPANY_A}/job-1`) {
      return json([{ name: "reported.jpg", id: "f1" }, { name: "orphan.jpg", id: "f2" }]);
    }
    if (prefix === `${COMPANY_A}/job-2`) return json([{ name: "x.png", id: "f3" }]);
    return json([]);
  }

  if (url.pathname === "/storage/v1/object/job-photos" && req.method === "DELETE") {
    if (storageFails) return json({ statusCode: "500", error: "boom", message: "boom" }, 500);
    return json([]);
  }

  return json({ message: `unexpected call ${req.method} ${url.pathname}` }, 500);
};

type Handler = (req: Request) => Response | Promise<Response>;

async function loadHandler(): Promise<Handler> {
  let captured: Handler | undefined;
  const originalServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (handler: Handler) => {
    captured = handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
  };
  try {
    await import("../delete-account/index.ts");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = originalServe;
  }
  if (!captured) throw new Error("Deno.serve wurde nicht aufgerufen");
  return captured;
}

const handler = await loadHandler();

async function call(token: string | null, body: unknown = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await handler(new Request(`${SUPABASE_URL}/functions/v1/delete-account`, {
    method: "POST", headers, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function reset() {
  calls = [];
  deletedUsers.clear();
  storageFails = false;
}

const called = (path: string) => calls.filter((c) => c.path === path);
const authDeletes = () => calls.filter((c) => c.path.startsWith("/auth/v1/admin/users/"));

Deno.test("Mitarbeiter: normaler Pfad löscht nur das eigene Konto", async () => {
  reset();
  const r = await call("tok-employee", { userId: U_SOLO_ADMIN });
  assertEquals(r.status, 200);
  assertEquals(r.body.companyDeleted, undefined);
  assertEquals(authDeletes().map((c) => c.path), [`/auth/v1/admin/users/${U_EMPLOYEE}`]);
  assertEquals(called("/rest/v1/rpc/purge_company_for_last_admin").length, 0);
});

Deno.test("Zwei Admins: Admin ohne Bestätigung wird normal gelöscht, Firma bleibt", async () => {
  reset();
  const r = await call("tok-duo-admin");
  assertEquals(r.status, 200);
  assertEquals(authDeletes().map((c) => c.path), [`/auth/v1/admin/users/${U_DUO_ADMIN}`]);
  assertEquals(called("/rest/v1/rpc/purge_company_for_last_admin").length, 0);
});

Deno.test("Zwei Admins: Firmenlöschung bestätigt -> not_last_admin, nichts gelöscht", async () => {
  reset();
  const r = await call("tok-duo-admin", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_B });
  assertEquals(r.status, 409);
  assertEquals(r.body.code, "not_last_admin");
  assertEquals(authDeletes().length, 0);
  assertEquals(called("/storage/v1/object/job-photos").length, 0);
});

Deno.test("Letzter Admin ohne Bestätigung -> 409 last_admin, keine Löschung", async () => {
  reset();
  const r = await call("tok-solo-admin");
  assertEquals(r.status, 409);
  assertEquals(r.body.code, "last_admin");
  assertEquals(authDeletes().length, 0);
  assertEquals(called("/rest/v1/rpc/purge_company_for_last_admin").length, 0);
});

Deno.test("Letzter Admin mit Bestätigung: Purge mit Session-ID + Storage-Aufräumen", async () => {
  reset();
  const r = await call("tok-solo-admin", {
    confirmCompanyDeletion: true,
    confirmCompanyId: COMPANY_A,
    // Body-Identität muss ignoriert werden
    p_caller: U_DUO_ADMIN,
    userId: U_DUO_ADMIN,
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.companyDeleted, true);
  assertEquals(r.body.storageCleanup, "ok");
  assertEquals(r.body.retainedRecordCount, 3);

  const purge = called("/rest/v1/rpc/purge_company_for_last_admin");
  assertEquals(purge.length, 1);
  assertEquals(purge[0].body, { p_caller: U_SOLO_ADMIN, p_confirm_company_id: COMPANY_A });

  const removed = called("/storage/v1/object/job-photos")
    .flatMap((c) => (c.body as { prefixes: string[] }).prefixes)
    .sort();
  assertEquals(removed, [
    `${COMPANY_A}/job-1/orphan.jpg`,
    `${COMPANY_A}/job-1/reported.jpg`,
    `${COMPANY_A}/job-2/x.png`,
  ]);
  // Konto wird in der Purge-Transaktion gelöscht, kein separates deleteUser
  assertEquals(authDeletes().length, 0);
});

Deno.test("Gefälschte Firmen-ID -> company_mismatch, nichts gelöscht", async () => {
  reset();
  const r = await call("tok-solo-admin", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_B });
  assertEquals(r.status, 403);
  assertEquals(r.body.code, "company_mismatch");
  assertEquals(authDeletes().length, 0);
  assertEquals(called("/storage/v1/object/list/job-photos").length, 0);
  assertEquals(called("/storage/v1/object/job-photos").length, 0);
});

Deno.test("Mitarbeiter mit Firmenlöschungs-Bestätigung -> abgelehnt, nichts gelöscht", async () => {
  reset();
  const r = await call("tok-employee", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_B });
  assertEquals(r.status, 403);
  assertEquals(r.body.code, "company_mismatch");
  assertEquals(authDeletes().length, 0);
});

Deno.test("Bestätigung ohne Firmen-ID -> 400, keine RPC", async () => {
  reset();
  const r = await call("tok-solo-admin", { confirmCompanyDeletion: true });
  assertEquals(r.status, 400);
  assertEquals(called("/rest/v1/rpc/purge_company_for_last_admin").length, 0);
});

Deno.test("Wiederholter Aufruf nach erfolgreicher Firmenlöschung -> 401, kein Effekt", async () => {
  reset();
  const first = await call("tok-solo-admin", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_A });
  assertEquals(first.status, 200);
  calls = [];
  const second = await call("tok-solo-admin", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_A });
  assertEquals(second.status, 401);
  assertEquals(called("/rest/v1/rpc/purge_company_for_last_admin").length, 0);
  assertEquals(authDeletes().length, 0);
});

Deno.test("Storage-Fehler nach Purge: Erfolg mit storageCleanup=partial", async () => {
  reset();
  storageFails = true;
  const r = await call("tok-solo-admin", { confirmCompanyDeletion: true, confirmCompanyId: COMPANY_A });
  assertEquals(r.status, 200);
  assertEquals(r.body.storageCleanup, "partial");
});

Deno.test("Ohne Session -> 401", async () => {
  reset();
  const r = await call(null);
  assertEquals(r.status, 401);
  assert(calls.every((c) => !c.path.startsWith("/rest/v1/rpc/")));
});
