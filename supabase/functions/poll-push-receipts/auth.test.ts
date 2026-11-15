// =========================================================
// TEST: poll-push-receipts — Autorisierung (verify_jwt = false)
// =========================================================
// Einziger zulässiger Aufrufer ist der pg_cron-Sweeper mit exakt passendem
// x-sweeper-secret. Weder ein Service-Role-Bearer noch ein User-JWT öffnet
// die Function; ohne konfiguriertes Secret ist sie vollständig zu. Jede
// Ablehnung passiert vor dem ersten RPC (claim_receipt_checks) und vor jedem
// Expo-Aufruf. Kein Netzwerk: globalThis.fetch zählt nur Aufrufe.
//
// AUSFÜHREN:
//   deno test --no-config --allow-env --deny-net supabase/functions/poll-push-receipts/auth.test.ts

import { assertEquals } from "jsr:@std/assert@1";

const SERVICE_ROLE = "test-service-role-key";
const SWEEPER = "sweeper-secret";
Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("DISPATCH_SWEEPER_SECRET", SWEEPER);

const { handleRequest } = await import("./index.ts");

let fetches: string[] = [];
globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  fetches.push(`${req.method} ${new URL(req.url).pathname}`);
  return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
};

async function call(headers: Record<string, string>) {
  fetches = [];
  const res = await handleRequest(new Request("http://fn.test/poll-push-receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

Deno.test("Service-Role-Bearer / User-JWT ohne Sweeper-Secret -> 401, kein Aufruf", async () => {
  for (const auth of [`Bearer ${SERVICE_ROLE}`, "Bearer some-user-jwt", ""]) {
    const r = await call(auth ? { Authorization: auth } : {});
    assertEquals(r.status, 401, auth);
    assertEquals(fetches, []);
  }
});

Deno.test("falsches Sweeper-Secret (gleiche Länge, Präfix, Suffix, leer, Service-Role-Key) -> 401", async () => {
  for (const wrong of ["sweeper-secreT", "sweeper-secre", `${SWEEPER}x`, "", SERVICE_ROLE]) {
    const r = await call({ "x-sweeper-secret": wrong });
    assertEquals(r.status, 401, wrong);
    assertEquals(fetches, []);
  }
});

Deno.test("Secret nicht konfiguriert -> jeder Aufruf 401, auch mit 'passendem' Header", async () => {
  Deno.env.delete("DISPATCH_SWEEPER_SECRET");
  try {
    for (const header of [SWEEPER, ""]) {
      const r = await call({ "x-sweeper-secret": header });
      assertEquals(r.status, 401);
      assertEquals(fetches, []);
    }
  } finally {
    Deno.env.set("DISPATCH_SWEEPER_SECRET", SWEEPER);
  }
});

Deno.test("korrektes Sweeper-Secret -> Claim-RPC läuft (Positivkontrolle)", async () => {
  const r = await call({ "x-sweeper-secret": SWEEPER });
  assertEquals(r.status, 200);
  assertEquals(fetches, ["POST /rest/v1/rpc/claim_receipt_checks"]);
});
