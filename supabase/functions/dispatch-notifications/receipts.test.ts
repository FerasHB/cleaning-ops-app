// =========================================================
// TEST: dispatch-notifications — Ticket-Persistenz + bedingte
// Token-Bereinigung (F2, Migration 20261018000000)
// =========================================================
// Kein Netzwerk: globalThis.fetch simuliert PostgREST-RPCs und Expo
// /push/send. Geprüft wird, was der Dispatcher an die RPCs übergibt:
//   * ok-Ticket ⇒ complete_notification_delivery mit Ticket-ID + SHA-256 des
//     verwendeten Tokens (bytea-Literal), sonst unveränderte Parameter
//   * ok-Ticket ohne ID ⇒ Parameter exakt wie vor F2
//   * DeviceNotRegistered-Ticket ⇒ clear_push_token_if_matches (Hash) statt
//     ungeprüftem profiles-Update, danach permanent_fail
//   * andere Ticket-Fehler / HTTP-Fehler ⇒ retry wie bisher, ohne Receipt-Daten
//
// AUSFÜHREN:
//   deno test --allow-env supabase/functions/dispatch-notifications/receipts.test.ts

import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("DISPATCH_SWEEPER_SECRET", "sweeper-secret");

const { handleRequest, sha256Hex, byteaHex, completeDeliveryParams } = await import("./index.ts");

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";

type Rpc = { name: string; body: Record<string, unknown> };
let claimQueue: unknown[][] = [];
let expoResponse: { status: number; body: unknown } = { status: 200, body: { data: [] } };
let rpcs: Rpc[] = [];
let tableCalls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.url === EXPO_SEND) {
    return json(expoResponse.body, expoResponse.status);
  }
  const path = new URL(req.url).pathname;
  if (path.startsWith("/rest/v1/rpc/")) {
    const name = path.slice("/rest/v1/rpc/".length);
    const body = await req.json();
    rpcs.push({ name, body });
    if (name === "fanout_notification_events") return json(0);
    if (name === "claim_notification_deliveries") return json(claimQueue.shift() ?? []);
    if (name === "complete_notification_delivery") {
      return json(body.outcome === "permanent_fail" ? "failed" : body.outcome === "retry" ? "pending" : body.outcome);
    }
    if (name === "clear_push_token_if_matches") return json(true);
  }
  tableCalls.push(`${req.method} ${path}`);
  return json({ message: "unexpected" }, 500);
};

function delivery(n: number, token: string) {
  return {
    delivery_id: `d${n}`, outbox_id: `o${n}`, recipient_id: `r${n}`, attempts: 1,
    event_type: "job_started", job_id: `j${n}`, company_id: "c1", job_status: "in_progress",
    employee_id: "e1", employee_name: "Erika", customer_name: "Kunde", service_name: "Reinigung",
    expo_push_token: token, recipient_active: true, recipient_role: "admin", recipient_locale: "de",
    entity_type: "job", entity_id: `j${n}`, absence_start_date: null, absence_end_date: null,
  };
}

async function run(rows: unknown[], tickets: { status: number; body: unknown }) {
  claimQueue = [rows];
  expoResponse = tickets;
  rpcs = [];
  tableCalls = [];
  const res = await handleRequest(new Request("http://fn.test/dispatch-notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sweeper-secret": "sweeper-secret" },
    body: "{}",
  }));
  return { res, completes: rpcs.filter((r) => r.name === "complete_notification_delivery").map((r) => r.body) };
}

Deno.test("sha256Hex entspricht extensions.digest(text,'sha256') in Postgres", async () => {
  // select encode(extensions.digest('abc','sha256'),'hex')
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assertEquals(byteaHex("ab12"), "\\xab12");
});

Deno.test("completeDeliveryParams: Receipt-Felder nur bei sent mit Ticket-ID", () => {
  const base = { delivery_id_input: "d", outcome: "retry", error_input: "x", max_attempts: 5 };
  assertEquals(completeDeliveryParams("d", "retry", "x", { ticketId: "t", tokenSha256Hex: "aa" }), base);
  assertEquals(completeDeliveryParams("d", "sent", undefined, { ticketId: null, tokenSha256Hex: "aa" }),
    { delivery_id_input: "d", outcome: "sent", error_input: null, max_attempts: 5 });
  assertEquals(completeDeliveryParams("d", "sent", undefined, { ticketId: "t", tokenSha256Hex: "aa" }),
    { delivery_id_input: "d", outcome: "sent", error_input: null, max_attempts: 5,
      expo_ticket_id_input: "t", push_token_sha256_input: "\\xaa" });
});

Deno.test("ok-Ticket ⇒ sent mit Ticket-ID + Hash des tatsächlich verwendeten Tokens", async () => {
  const token = "ExponentPushToken[deviceA]";
  const { res, completes } = await run([delivery(1, token)], {
    status: 200, body: { data: [{ status: "ok", id: "ticket-1" }] },
  });
  assertEquals(res.status, 200);
  assertEquals(completes, [{
    delivery_id_input: "d1", outcome: "sent", error_input: null, max_attempts: 5,
    expo_ticket_id_input: "ticket-1", push_token_sha256_input: byteaHex(await sha256Hex(token)),
  }]);
  assertEquals(tableCalls, []);
});

Deno.test("ok-Ticket ohne ID ⇒ Parameter exakt wie vor F2", async () => {
  const { completes } = await run([delivery(1, "ExponentPushToken[x]")], {
    status: 200, body: { data: [{ status: "ok" }] },
  });
  assertEquals(completes, [{ delivery_id_input: "d1", outcome: "sent", error_input: null, max_attempts: 5 }]);
});

Deno.test("DeviceNotRegistered-Ticket ⇒ bedingte Bereinigung per Hash, kein profiles-Update, permanent_fail", async () => {
  const token = "ExponentPushToken[deviceGone]";
  const { completes } = await run([delivery(2, token)], {
    status: 200, body: { data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] },
  });
  assertEquals(rpcs.filter((r) => r.name === "clear_push_token_if_matches").map((r) => r.body),
    [{ p_recipient_id: "r2", p_token_sha256: byteaHex(await sha256Hex(token)) }]);
  assertEquals(tableCalls, []); // kein direktes PATCH /rest/v1/profiles mehr
  assertEquals(completes, [{ delivery_id_input: "d2", outcome: "permanent_fail", error_input: "DeviceNotRegistered", max_attempts: 5 }]);
});

Deno.test("Batch: Tickets bleiben positionsgenau den Deliveries zugeordnet", async () => {
  const tA = "ExponentPushToken[a]", tB = "ExponentPushToken[b]", tC = "ExponentPushToken[c]";
  const { completes } = await run([delivery(1, tA), delivery(2, tB), delivery(3, tC)], {
    status: 200,
    body: { data: [
      { status: "ok", id: "T1" },
      { status: "error", details: { error: "MessageRateExceeded" } },
      { status: "ok", id: "T3" },
    ] },
  });
  assertEquals(completes.map((c) => [c.delivery_id_input, c.outcome, c.expo_ticket_id_input ?? null]),
    [["d1", "sent", "T1"], ["d2", "retry", null], ["d3", "sent", "T3"]]);
  assertEquals(completes[2].push_token_sha256_input, byteaHex(await sha256Hex(tC)));
  assertEquals(rpcs.some((r) => r.name === "clear_push_token_if_matches"), false);
});

Deno.test("Expo-HTTP-Fehler ⇒ retry für alle, ohne Receipt-Daten (unverändert)", async () => {
  const { completes } = await run([delivery(1, "ExponentPushToken[a]")], { status: 503, body: { errors: [] } });
  assertEquals(completes.map((c) => [c.outcome, "expo_ticket_id_input" in c]), [["retry", false]]);
});
