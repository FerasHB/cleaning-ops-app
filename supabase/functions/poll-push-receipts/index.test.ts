// =========================================================
// TEST: poll-push-receipts — Receipt-Klassifikation + Handler (F2)
// =========================================================
// Kein Netzwerk: globalThis.fetch simuliert PostgREST-RPCs
// (claim_receipt_checks, complete_receipt_check) und Expo getReceipts.
// Geprüft wird, welches outcome/error je Delivery an complete_receipt_check
// geht — die Zustandsübergänge selbst testet
// supabase/tests/expo_push_receipts.test.sql.
//
// AUSFÜHREN:
//   deno test --allow-env supabase/functions/poll-push-receipts/index.test.ts

import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("DISPATCH_SWEEPER_SECRET", "sweeper-secret");

const { classifyReceipt, classifyReceipts, handleRequest, EXPO_RECEIPTS_ENDPOINT } = await import("./index.ts");

// ---------------------------------------------------------
// Reine Klassifikation
// ---------------------------------------------------------
Deno.test("classifyReceipt: ok", () => {
  assertEquals(classifyReceipt({ status: "ok" }), { outcome: "ok", error: null });
});

for (const code of ["DeviceNotRegistered", "MessageTooBig", "MessageRateExceeded", "InvalidCredentials", "MismatchSenderId"]) {
  Deno.test(`classifyReceipt: ${code} ⇒ terminal error mit Code`, () => {
    assertEquals(
      classifyReceipt({ status: "error", message: "irrelevant", details: { error: code } }),
      { outcome: "error", error: code },
    );
  });
}

Deno.test("classifyReceipt: error ohne details ⇒ message, sonst unknown", () => {
  assertEquals(classifyReceipt({ status: "error", message: "boom" }), { outcome: "error", error: "boom" });
  assertEquals(classifyReceipt({ status: "error" }), { outcome: "error", error: "unknown" });
});

Deno.test("classifyReceipt: fehlend ⇒ missing; unbekannter Status ⇒ error", () => {
  assertEquals(classifyReceipt(undefined), { outcome: "missing", error: null });
  assertEquals(classifyReceipt({ status: "weird" }), { outcome: "error", error: "unknown_receipt_status" });
  assertEquals(classifyReceipt("x"), { outcome: "error", error: "malformed_receipt" });
});

Deno.test("classifyReceipts: fehlende ID ⇒ missing, unbrauchbare Antwort ⇒ null", () => {
  const m = classifyReceipts(["a", "b"], { data: { a: { status: "ok" } } });
  assertEquals(m?.get("a"), { outcome: "ok", error: null });
  assertEquals(m?.get("b"), { outcome: "missing", error: null });
  assertEquals(classifyReceipts(["a"], null), null);
  assertEquals(classifyReceipts(["a"], { errors: [{ code: "X" }] }), null);
  assertEquals(classifyReceipts(["a"], { data: [] }), null);
  // Prototyp-Schlüssel sind keine Receipts
  assertEquals(classifyReceipts(["toString"], { data: {} })?.get("toString"), { outcome: "missing", error: null });
});

// ---------------------------------------------------------
// Handler mit simuliertem fetch
// ---------------------------------------------------------
type Claimed = { delivery_id: string; expo_ticket_id: string; receipt_attempts: number; sent_at: string };
type Expo = { status: number; body?: unknown; raw?: string; throws?: boolean };

let claimed: Claimed[] = [];
let expo: Expo = { status: 200, body: { data: {} } };
let completions: { p_delivery_id: string; p_outcome: string; p_error: string | null }[] = [];
let expoRequests: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = req.url;
  if (url === EXPO_RECEIPTS_ENDPOINT) {
    expoRequests.push(await req.json());
    if (expo.throws) throw new TypeError("connection reset");
    if (expo.raw !== undefined) return new Response(expo.raw, { status: expo.status });
    return json(expo.body ?? {}, expo.status);
  }
  const path = new URL(url).pathname;
  if (path === "/rest/v1/rpc/claim_receipt_checks") return json(claimed);
  if (path === "/rest/v1/rpc/complete_receipt_check") {
    const body = await req.json();
    completions.push(body);
    return json(body.p_outcome === "missing" ? "pending" : body.p_outcome);
  }
  return json({ message: `unexpected ${path}` }, 500);
};

function call(secret: string | null = "sweeper-secret"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-sweeper-secret"] = secret;
  return handleRequest(new Request("http://fn.test/poll-push-receipts", { method: "POST", headers, body: "{}" }));
}

function reset(rows: Claimed[], e: Expo) {
  claimed = rows;
  expo = e;
  completions = [];
  expoRequests = [];
}

const row = (n: number): Claimed => ({
  delivery_id: `d${n}`, expo_ticket_id: `t${n}`, receipt_attempts: 0, sent_at: "2026-10-15T20:00:00Z",
});

Deno.test("Handler: ohne/mit falschem Secret ⇒ 401, kein Claim", async () => {
  reset([row(1)], { status: 200, body: { data: {} } });
  assertEquals((await call(null)).status, 401);
  assertEquals((await call("wrong")).status, 401);
  assertEquals(completions.length, 0);
  assertEquals(expoRequests.length, 0);
});

Deno.test("Handler: nichts fällig ⇒ kein Expo-Aufruf", async () => {
  reset([], { status: 200, body: { data: {} } });
  const res = await call();
  assertEquals(res.status, 200);
  assertEquals((await res.json()).claimed, 0);
  assertEquals(expoRequests.length, 0);
});

Deno.test("Handler: gemischte Receipts werden je Delivery verbucht", async () => {
  reset([1, 2, 3, 4, 5, 6, 7].map(row), {
    status: 200,
    body: {
      data: {
        t1: { status: "ok" },
        t2: { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
        t3: { status: "error", details: { error: "MessageTooBig" } },
        t4: { status: "error", details: { error: "MessageRateExceeded" } },
        t5: { status: "error", details: { error: "InvalidCredentials" } },
        t6: { status: "error", details: { error: "MismatchSenderId" } },
        // t7 fehlt ⇒ missing
      },
    },
  });
  const res = await call();
  const out = await res.json();
  assertEquals(res.status, 200);
  assertEquals(expoRequests, [{ ids: ["t1", "t2", "t3", "t4", "t5", "t6", "t7"] }]);
  assertEquals(
    completions.map((c) => [c.p_delivery_id, c.p_outcome, c.p_error]),
    [
      ["d1", "ok", null],
      ["d2", "error", "DeviceNotRegistered"],
      ["d3", "error", "MessageTooBig"],
      ["d4", "error", "MessageRateExceeded"],
      ["d5", "error", "InvalidCredentials"],
      ["d6", "error", "MismatchSenderId"],
      ["d7", "missing", null],
    ],
  );
  assertEquals({ claimed: out.claimed, ok: out.ok, error: out.error, missing: out.missing, infra: out.infra },
    { claimed: 7, ok: 1, error: 5, missing: 1, infra: 0 });
});

for (const status of [429, 500, 503]) {
  Deno.test(`Handler: Expo HTTP ${status} ⇒ alle infra (kein Fehlen)`, async () => {
    reset([row(1), row(2)], { status, body: { errors: [{ code: "TOO_MANY_REQUESTS" }] } });
    await call();
    assertEquals(completions.map((c) => c.p_outcome), ["infra", "infra"]);
    assertEquals(completions[0].p_error, `Expo getReceipts HTTP ${status}`);
  });
}

Deno.test("Handler: Netzwerkfehler ⇒ infra", async () => {
  reset([row(1)], { status: 200, throws: true });
  await call();
  assertEquals(completions.map((c) => c.p_outcome), ["infra"]);
});

Deno.test("Handler: unlesbare Antwort (kein JSON / ohne data) ⇒ infra", async () => {
  reset([row(1)], { status: 200, raw: "<html>gateway</html>" });
  await call();
  assertEquals(completions.map((c) => [c.p_outcome, c.p_error]), [["infra", "malformed getReceipts response"]]);
  reset([row(1)], { status: 200, body: { errors: [{ code: "PUSH_TOO_MANY_RECEIPTS" }] } });
  await call();
  assertEquals(completions.map((c) => c.p_outcome), ["infra"]);
});

Deno.test("Handler: max. 1000 IDs je getReceipts-Aufruf", async () => {
  reset(Array.from({ length: 1000 }, (_, i) => row(i)), { status: 200, body: { data: {} } });
  await call();
  assertEquals(expoRequests.length, 1);
  assertEquals((expoRequests[0] as { ids: string[] }).ids.length, 1000);
  assertEquals(completions.every((c) => c.p_outcome === "missing"), true);
});
