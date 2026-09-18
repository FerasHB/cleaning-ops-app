// =========================================================
// TEST: dispatch-notifications — Event-Routing, Vorlagen, Zustellbarkeit
// (Regression für 20260916130000/140000 — Notification-Integrität + -Latenz)
// =========================================================
// Reine Unit-Tests der EXPORTIERTEN Funktionen aus index.ts — kein Netzwerk,
// keine echte Supabase-Verbindung, kein echter Expo-Versand. Prüft genau die
// Regression, die diesen Fix ausgelöst hat: verliert claim_notification_
// deliveries() erneut entity_type/entity_id (oder liefert ein unbekanntes
// event_type), darf NIEMALS eine "hat <Auftrag> gestartet."-Nachricht
// entstehen.
//
// AUSFÜHREN:
//   deno test supabase/functions/dispatch-notifications/index.test.ts
// (volle Typprüfung, kein --no-check nötig — siehe markDelivery()-Signatur
//  in index.ts: SupabaseClient statt ReturnType<typeof createClient>.)

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  buildContent,
  expectedRoleFor,
  isEligible,
  isRoutableEvent,
  type ClaimedDelivery,
} from "./index.ts";
import {
  resolveNotificationLocale,
  type NotificationLocale,
} from "../_shared/notificationTranslations.ts";

function row(overrides: Partial<ClaimedDelivery>): ClaimedDelivery {
  return {
    delivery_id: "d1",
    outbox_id: "o1",
    recipient_id: "r1",
    attempts: 1,
    event_type: "job_started",
    job_id: "j1",
    company_id: "c1",
    job_status: "in_progress",
    employee_id: "e1",
    employee_name: "Erika Musterfrau",
    customer_name: "Kunde GmbH",
    service_name: "Fensterreinigung",
    expo_push_token: "ExponentPushToken[abc]",
    recipient_active: true,
    recipient_role: "admin",
    recipient_locale: "de",
    entity_type: "job",
    entity_id: "j1",
    absence_start_date: null,
    absence_end_date: null,
    ...overrides,
  };
}

const LOCALES: NotificationLocale[] = ["de", "en", "ar", "tr"];

// ---------------------------------------------------------
// B/G — Event-Routing: JEDER unterstützte Typ, KEIN Fallback auf job_started
// ---------------------------------------------------------

Deno.test("isRoutableEvent: alle 9 unterstützten Event-Typen mit korrektem entity_type sind routbar", () => {
  const cases: Array<[string, string]> = [
    ["job_started", "job"],
    ["job_completed", "job"],
    ["job_assigned", "job"],
    ["comment_added", "comment"],
    ["vacation_requested", "absence"],
    ["sickness_reported", "absence"],
    ["sickness_updated", "absence"],
    ["vacation_approved", "absence"],
    ["vacation_rejected", "absence"],
  ];
  for (const [event_type, entity_type] of cases) {
    assert(
      isRoutableEvent(row({ event_type, entity_type })),
      `${event_type}/${entity_type} sollte routbar sein`,
    );
  }
});

Deno.test("isRoutableEvent: DIE Regression — entity_type fehlt (undefined/null) macht comment/absence NICHT routbar", () => {
  // Das ist exakt der Produktionsfehler: claim_notification_deliveries()
  // ohne entity_type/entity_id liefert diese Spalte als null (JS: undefined
  // bei fehlender Spalte, null bei vorhandener-aber-leerer Spalte je nach
  // RPC-Version — beide Fälle müssen NICHT-routbar sein, niemals implizit
  // "job" annehmen).
  assert(!isRoutableEvent(row({ event_type: "comment_added", entity_type: null })));
  assert(!isRoutableEvent(row({ event_type: "vacation_requested", entity_type: null })));
  assert(!isRoutableEvent(row({ event_type: "sickness_reported", entity_type: null })));
  assert(!isRoutableEvent(row({ event_type: "vacation_approved", entity_type: null })));
});

Deno.test("isRoutableEvent: unbekannter event_type ist NIE routbar, auch nicht mit entity_type='job'", () => {
  assert(!isRoutableEvent(row({ event_type: "some_future_event", entity_type: "job" })));
  assert(!isRoutableEvent(row({ event_type: "some_future_event", entity_type: null })));
  assert(!isRoutableEvent(row({ event_type: "some_future_event", entity_type: "comment" })));
});

Deno.test("isRoutableEvent: falsch zugeordneter entity_type ist nicht routbar (kreuzweise)", () => {
  // comment_added mit entity_type='absence' (oder 'job') ist eine
  // strukturell inkonsistente Zeile -> nicht routbar, nicht raten.
  assert(!isRoutableEvent(row({ event_type: "comment_added", entity_type: "absence" })));
  assert(!isRoutableEvent(row({ event_type: "comment_added", entity_type: "job" })));
  assert(!isRoutableEvent(row({ event_type: "vacation_requested", entity_type: "comment" })));
  assert(!isRoutableEvent(row({ event_type: "job_started", entity_type: "absence" })));
});

// ---------------------------------------------------------
// D — Kommentar-Payload: NIE job_started-Text
// ---------------------------------------------------------

Deno.test("buildContent: comment_added erzeugt IMMER die Kommentar-Vorlage, nie job_started", () => {
  for (const locale of LOCALES) {
    const r = row({ event_type: "comment_added", entity_type: "comment", entity_id: "cmt-1", job_id: "j1" });
    const content = buildContent(r, locale);
    const jobStarted = buildContent(row({ event_type: "job_started", entity_type: "job" }), locale);
    assertNotEquals(content.title, jobStarted.title, `[${locale}] Kommentar-Titel darf nicht dem Job-Start-Titel entsprechen`);
    assertNotEquals(content.body, jobStarted.body, `[${locale}] Kommentar-Text darf nicht dem Job-Start-Text entsprechen`);
    // Body muss den Namen des Kommentators enthalten (serverseitig NIE übersetzt).
    assert(content.body.includes("Erika Musterfrau"));
  }
});

// ---------------------------------------------------------
// E — Abwesenheits-Payload: korrekte Vorlagenfamilie je Event
// ---------------------------------------------------------

Deno.test("buildContent: alle 5 Abwesenheits-Event-Typen erzeugen absence-Vorlagen, nie job_started", () => {
  const absenceEvents = [
    "vacation_requested",
    "sickness_reported",
    "sickness_updated",
    "vacation_approved",
    "vacation_rejected",
  ];
  for (const locale of LOCALES) {
    const jobStarted = buildContent(row({ event_type: "job_started", entity_type: "job" }), locale);
    for (const event_type of absenceEvents) {
      const r = row({
        event_type,
        entity_type: "absence",
        entity_id: "abs-1",
        job_id: null as unknown as string,
        absence_start_date: "2026-08-10",
        absence_end_date: "2026-08-14",
      });
      const content = buildContent(r, locale);
      assertNotEquals(content.body, jobStarted.body, `[${locale}] ${event_type} darf nicht wie job_started klingen`);
    }
  }
});

Deno.test("buildContent: sickness_reported mit offenem Ende zeigt kein kaputtes Datum (alle Locales)", () => {
  for (const locale of LOCALES) {
    const r = row({
      event_type: "sickness_reported",
      entity_type: "absence",
      absence_start_date: "2026-08-10",
      absence_end_date: null,
    });
    const content = buildContent(r, locale);
    assert(!content.body.includes("null"));
    assert(!content.body.includes("undefined"));
  }
});

// ---------------------------------------------------------
// F — Job-Events unverändert
// ---------------------------------------------------------

Deno.test("buildContent: job_started und job_completed bleiben unterscheidbar (alle Locales)", () => {
  for (const locale of LOCALES) {
    const started = buildContent(row({ event_type: "job_started", entity_type: "job" }), locale);
    const completed = buildContent(row({ event_type: "job_completed", entity_type: "job" }), locale);
    assertNotEquals(started.title, completed.title, `[${locale}]`);
    assertNotEquals(started.body, completed.body, `[${locale}]`);
  }
});

Deno.test("buildContent: job_assigned erzeugt die Zuweisungs-Vorlage (alle Locales)", () => {
  for (const locale of LOCALES) {
    const assigned = buildContent(row({ event_type: "job_assigned", entity_type: "job" }), locale);
    const started = buildContent(row({ event_type: "job_started", entity_type: "job" }), locale);
    assertNotEquals(assigned.body, started.body, `[${locale}]`);
  }
});

// ---------------------------------------------------------
// C — Sprachen: jede Familie liefert für jede Locale einen ANDEREN,
// nicht-deutschen Text als den de-Text (stellt sicher, dass tatsächlich
// lokalisiert wird, nicht nur ein Locale-Parameter durchgereicht wird).
// ---------------------------------------------------------

Deno.test("buildContent: DE/EN/AR/TR liefern für dieselbe Zeile vier unterschiedliche Titel", () => {
  const families: Array<[string, string]> = [
    ["job_started", "job"],
    ["job_completed", "job"],
    ["job_assigned", "job"],
    ["comment_added", "comment"],
    ["vacation_requested", "absence"],
  ];
  for (const [event_type, entity_type] of families) {
    const r = row({ event_type, entity_type });
    const titles = new Set(LOCALES.map((l) => buildContent(r, l).title));
    assertEquals(titles.size, 4, `${event_type}: erwarte 4 unterschiedliche Titel über de/en/ar/tr, bekam ${[...titles]}`);
  }
});

Deno.test("resolveNotificationLocale: unbekannte/fehlende Locale fällt auf 'de' zurück", () => {
  assertEquals(resolveNotificationLocale(null), "de");
  assertEquals(resolveNotificationLocale(undefined), "de");
  assertEquals(resolveNotificationLocale("fr"), "de");
  assertEquals(resolveNotificationLocale("en"), "en");
  assertEquals(resolveNotificationLocale("ar"), "ar");
  assertEquals(resolveNotificationLocale("tr"), "tr");
});

// ---------------------------------------------------------
// Zustellbarkeit (Rollen-Gate) — unverändert von diesem Fix, hier nur
// gegen Regression abgesichert.
// ---------------------------------------------------------

Deno.test("isEligible/expectedRoleFor: Rollen-Erwartung je Event-Typ unverändert", () => {
  assertEquals(expectedRoleFor("job_started"), "admin");
  assertEquals(expectedRoleFor("job_completed"), "admin");
  assertEquals(expectedRoleFor("job_assigned"), "employee");
  assertEquals(expectedRoleFor("vacation_requested"), "admin");
  assertEquals(expectedRoleFor("sickness_reported"), "admin");
  assertEquals(expectedRoleFor("sickness_updated"), "admin");
  assertEquals(expectedRoleFor("vacation_approved"), "employee");
  assertEquals(expectedRoleFor("vacation_rejected"), "employee");
  assertEquals(expectedRoleFor("comment_added"), "any");

  assert(isEligible(row({ event_type: "job_started", recipient_role: "admin", recipient_active: true })));
  assert(!isEligible(row({ event_type: "job_started", recipient_role: "employee", recipient_active: true })));
  assert(!isEligible(row({ event_type: "job_started", recipient_role: "admin", recipient_active: false })));
  assert(isEligible(row({ event_type: "comment_added", recipient_role: "employee", recipient_active: true })));
  assert(isEligible(row({ event_type: "comment_added", recipient_role: "admin", recipient_active: true })));
});
