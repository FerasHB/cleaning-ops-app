// Server-seitige Übersetzungen für Push-Benachrichtigungen (Phase E).
//
// WARUM EINE EIGENE, KLEINE STRUKTUR (statt der Client-i18n-Dateien):
// Die Edge Function läuft unter Deno und hat keinen Zugriff auf AsyncStorage
// oder die hunderte Übersetzungs-Keys der App — sie braucht nur die Handvoll
// Sätze, die dispatch-notifications tatsächlich versendet. Kein i18next o.ä.,
// nur ein typisiertes Objekt pro Sprache mit kleinen Bau-Funktionen.
//
// WICHTIG: Hier wird NIEMALS gespeicherte Geschäftsdaten übersetzt (Kunden-
// name, Mitarbeitername, Leistungs-/Jobtitel, Kommentartext) — nur die
// umgebende Grammatik/Labels. Diese Werte kommen bereits fertig (aus
// notification_deliveries) als Parameter in die body()-Funktionen.
//
// Fallback: unbekannte/fehlende/ungültige Locale -> "de" (Projekt-Kanon).

export type NotificationLocale = "de" | "en" | "ar" | "tr";

const SUPPORTED_LOCALES: readonly NotificationLocale[] = ["de", "en", "ar", "tr"];
const DEFAULT_LOCALE: NotificationLocale = "de";

export function resolveNotificationLocale(
  value: string | null | undefined,
): NotificationLocale {
  if (value && (SUPPORTED_LOCALES as readonly string[]).includes(value)) {
    return value as NotificationLocale;
  }
  return DEFAULT_LOCALE;
}

export type PushContent = { title: string; body: string };

type Dict = {
  // Intl.DateTimeFormat-Locale-Tag für formatDate() in index.ts — dieselbe
  // Fallback-Kette (?? "de-DE") wie im Client (INTL_LOCALE_TAGS).
  dateLocaleTag: string;
  fallbackJobTitle: string;
  fallbackEmployeeName: string;
  fallbackSomeone: string;
  // " bei X" / " for X" / " (X)" / " لدى X" — Kunden-Zusatz an einen Jobtitel.
  atCustomer: (customer: string) => string;
  // "ab X" — offenes Zeitraum-Ende.
  rangeFrom: (from: string) => string;
  // "vom X bis Y" — geschlossener Zeitraum.
  rangeBetween: (from: string, to: string) => string;
  assignment: (p: { what: string; at: string }) => PushContent;
  jobStarted: (p: { who: string; what: string; at: string }) => PushContent;
  jobCompleted: (p: { who: string; what: string; at: string }) => PushContent;
  comment: (p: { who: string; what: string; at: string }) => PushContent;
  vacationRequested: (p: { who: string; range: string }) => PushContent;
  sicknessReported: (p: { who: string; range: string }) => PushContent;
  sicknessUpdated: (p: { who: string; to: string | null }) => PushContent;
  vacationApproved: (p: { rangeSuffix: string }) => PushContent;
  vacationRejected: (p: { rangeSuffix: string }) => PushContent;
  absenceDefault: (p: { who: string }) => PushContent;
};

const de: Dict = {
  dateLocaleTag: "de-DE",
  fallbackJobTitle: "Auftrag",
  fallbackEmployeeName: "Ein Mitarbeiter",
  fallbackSomeone: "Jemand",
  atCustomer: (c) => ` bei ${c}`,
  rangeFrom: (from) => `ab ${from}`,
  rangeBetween: (from, to) => `vom ${from} bis ${to}`,
  assignment: ({ what, at }) => ({
    title: "Neuer Auftrag",
    body: `Dir wurde „${what}“${at} zugewiesen.`,
  }),
  jobStarted: ({ who, what, at }) => ({
    title: "Auftrag gestartet",
    body: `${who} hat „${what}“${at} gestartet.`,
  }),
  jobCompleted: ({ who, what, at }) => ({
    title: "Auftrag abgeschlossen",
    body: `${who} hat „${what}“${at} abgeschlossen.`,
  }),
  comment: ({ who, what, at }) => ({
    title: "Neuer Kommentar",
    body: `${who} hat einen Kommentar zu „${what}“${at} geschrieben.`,
  }),
  vacationRequested: ({ who, range }) => ({
    title: "Neuer Urlaubsantrag",
    body: range ? `${who} hat Urlaub ${range} beantragt.` : `${who} hat Urlaub beantragt.`,
  }),
  sicknessReported: ({ who, range }) => ({
    title: "Neue Krankmeldung",
    body: range
      ? `${who} hat sich krankgemeldet (${range}).`
      : `${who} hat sich krankgemeldet.`,
  }),
  sicknessUpdated: ({ who, to }) => ({
    title: "Krankmeldung aktualisiert",
    body: to
      ? `${who} hat den Zeitraum der Krankmeldung geändert (neues Ende: ${to}).`
      : `${who} hat die Krankmeldung auf unbestimmte Zeit verlängert.`,
  }),
  vacationApproved: ({ rangeSuffix }) => ({
    title: "Urlaub genehmigt",
    body: `Dein Urlaubsantrag${rangeSuffix} wurde genehmigt.`,
  }),
  vacationRejected: ({ rangeSuffix }) => ({
    title: "Urlaub abgelehnt",
    body: `Dein Urlaubsantrag${rangeSuffix} wurde abgelehnt.`,
  }),
  absenceDefault: ({ who }) => ({
    title: "Abwesenheit",
    body: `${who}: Abwesenheit aktualisiert.`,
  }),
};

const en: Dict = {
  dateLocaleTag: "en-US",
  fallbackJobTitle: "Job",
  fallbackEmployeeName: "An employee",
  fallbackSomeone: "Someone",
  atCustomer: (c) => ` for ${c}`,
  rangeFrom: (from) => `from ${from}`,
  rangeBetween: (from, to) => `from ${from} to ${to}`,
  assignment: ({ what, at }) => ({
    title: "New job",
    body: `"${what}"${at} has been assigned to you.`,
  }),
  jobStarted: ({ who, what, at }) => ({
    title: "Job started",
    body: `${who} started "${what}"${at}.`,
  }),
  jobCompleted: ({ who, what, at }) => ({
    title: "Job completed",
    body: `${who} completed "${what}"${at}.`,
  }),
  comment: ({ who, what, at }) => ({
    title: "New comment",
    body: `${who} left a comment on "${what}"${at}.`,
  }),
  vacationRequested: ({ who, range }) => ({
    title: "New leave request",
    body: range ? `${who} requested leave ${range}.` : `${who} requested leave.`,
  }),
  sicknessReported: ({ who, range }) => ({
    title: "New sick leave report",
    body: range
      ? `${who} reported sick leave (${range}).`
      : `${who} reported sick leave.`,
  }),
  sicknessUpdated: ({ who, to }) => ({
    title: "Sick leave updated",
    body: to
      ? `${who} changed the sick leave period (new end date: ${to}).`
      : `${who} extended the sick leave for an unspecified period.`,
  }),
  vacationApproved: ({ rangeSuffix }) => ({
    title: "Leave approved",
    body: `Your leave request${rangeSuffix} has been approved.`,
  }),
  vacationRejected: ({ rangeSuffix }) => ({
    title: "Leave rejected",
    body: `Your leave request${rangeSuffix} has been rejected.`,
  }),
  absenceDefault: ({ who }) => ({
    title: "Absence",
    body: `${who}: absence updated.`,
  }),
};

const tr: Dict = {
  dateLocaleTag: "tr-TR",
  fallbackJobTitle: "İş",
  fallbackEmployeeName: "Bir çalışan",
  fallbackSomeone: "Biri",
  atCustomer: (c) => ` (${c})`,
  rangeFrom: (from) => `${from} tarihinden itibaren`,
  rangeBetween: (from, to) => `${from} - ${to} tarihleri arasında`,
  assignment: ({ what, at }) => ({
    title: "Yeni iş",
    body: `„${what}“${at} sana atandı.`,
  }),
  jobStarted: ({ who, what, at }) => ({
    title: "İş başladı",
    body: `${who}, „${what}“${at} işini başlattı.`,
  }),
  jobCompleted: ({ who, what, at }) => ({
    title: "İş tamamlandı",
    body: `${who}, „${what}“${at} işini tamamladı.`,
  }),
  comment: ({ who, what, at }) => ({
    title: "Yeni yorum",
    body: `${who}, „${what}“${at} için bir yorum yazdı.`,
  }),
  vacationRequested: ({ who, range }) => ({
    title: "Yeni izin talebi",
    body: range ? `${who}, ${range} izin talep etti.` : `${who} izin talep etti.`,
  }),
  sicknessReported: ({ who, range }) => ({
    title: "Yeni hastalık bildirimi",
    body: range
      ? `${who} hastalığını bildirdi (${range}).`
      : `${who} hastalığını bildirdi.`,
  }),
  sicknessUpdated: ({ who, to }) => ({
    title: "Hastalık bildirimi güncellendi",
    body: to
      ? `${who} hastalık dönemini değiştirdi (yeni bitiş: ${to}).`
      : `${who} hastalık iznini süresiz olarak uzattı.`,
  }),
  vacationApproved: ({ rangeSuffix }) => ({
    title: "İzin onaylandı",
    body: `İzin talebin${rangeSuffix} onaylandı.`,
  }),
  vacationRejected: ({ rangeSuffix }) => ({
    title: "İzin reddedildi",
    body: `İzin talebin${rangeSuffix} reddedildi.`,
  }),
  absenceDefault: ({ who }) => ({
    title: "Devamsızlık",
    body: `${who}: devamsızlık güncellendi.`,
  }),
};

const ar: Dict = {
  dateLocaleTag: "ar-SA",
  fallbackJobTitle: "مهمة",
  fallbackEmployeeName: "أحد الموظفين",
  fallbackSomeone: "شخص ما",
  atCustomer: (c) => ` لدى ${c}`,
  rangeFrom: (from) => `اعتبارًا من ${from}`,
  rangeBetween: (from, to) => `من ${from} إلى ${to}`,
  assignment: ({ what, at }) => ({
    title: "مهمة جديدة",
    body: `تم إسناد „${what}“${at} إليك.`,
  }),
  jobStarted: ({ who, what, at }) => ({
    title: "بدأت المهمة",
    body: `بدأ ${who} „${what}“${at}.`,
  }),
  jobCompleted: ({ who, what, at }) => ({
    title: "اكتملت المهمة",
    body: `أنهى ${who} „${what}“${at}.`,
  }),
  comment: ({ who, what, at }) => ({
    title: "تعليق جديد",
    body: `كتب ${who} تعليقًا على „${what}“${at}.`,
  }),
  vacationRequested: ({ who, range }) => ({
    title: "طلب إجازة جديد",
    body: range ? `طلب ${who} إجازة ${range}.` : `طلب ${who} إجازة.`,
  }),
  sicknessReported: ({ who, range }) => ({
    title: "بلاغ مرضي جديد",
    body: range ? `أبلغ ${who} عن مرض (${range}).` : `أبلغ ${who} عن مرض.`,
  }),
  sicknessUpdated: ({ who, to }) => ({
    title: "تحديث البلاغ المرضي",
    body: to
      ? `غيّر ${who} فترة البلاغ المرضي (تاريخ الانتهاء الجديد: ${to}).`
      : `مدّد ${who} الإجازة المرضية لفترة غير محددة.`,
  }),
  vacationApproved: ({ rangeSuffix }) => ({
    title: "تمت الموافقة على الإجازة",
    body: `تمت الموافقة على طلب إجازتك${rangeSuffix}.`,
  }),
  vacationRejected: ({ rangeSuffix }) => ({
    title: "تم رفض الإجازة",
    body: `تم رفض طلب إجازتك${rangeSuffix}.`,
  }),
  absenceDefault: ({ who }) => ({
    title: "غياب",
    body: `${who}: تم تحديث الغياب.`,
  }),
};

const DICTS: Record<NotificationLocale, Dict> = { de, en, tr, ar };

export function notificationTexts(locale: NotificationLocale): Dict {
  return DICTS[locale];
}
