// features/jobs/EmployeeJobsCalendarScreen.tsx
// ─────────────────────────────────────────────────────────────────
// Mitarbeiter-Jobs-Tab: VOLLFLÄCHIGER Monatskalender.
//
// Vorher war das ein kleiner Kalender-Block über einer Tagesliste — der
// Monat bekam ein Drittel des Bildschirms, die Zellen trugen nur einen Punkt
// („irgendwas ist an dem Tag"), und wer wissen wollte, wann er arbeitet,
// musste jeden Tag einzeln antippen.
//
// Jetzt ist der Monat der Bildschirm. Er ist bewusst eine PLANUNGS-Ansicht
// und beantwortet genau vier Fragen:
//   1. An welchen Tagen ist Arbeit?      → Zelle trägt eine Zusammenfassung
//   2. Wie viele Aufträge sind es?       → Zahl in der Zelle
//   3. Wie ist die grobe Statuslage?     → bis zu drei Punkte
//   4. Welchen Tag sehe ich gerade an?   → Heute-Kreis + Auswahl-Rahmen
//
// Was er ausdrücklich NICHT tut: einzelne Aufträge mit Uhrzeit und Kunde in
// jede Zelle schreiben. Ein erster Anlauf hat das getan; auf dem Gerät wurde
// daraus optisch eine zusammengepresste Jobliste im Rastergewand. Die
// vollständigen Auftragsdaten leben in der Tages-Agenda (und künftig im
// Jobs-Tab), der Kalender bleibt Überblick.
//
// Rollen-/Datenlage unverändert:
// - Datenquelle bleibt `useJobs().jobs` (Employee: RLS-begrenzt auf eigene
//   Aufträge, keine Firmen-Abfrage, keine eigene Query in diesem Screen).
// - Es werden weiterhin ausschließlich `jobType === "single"` gezeigt, also
//   echte Einzelaufträge UND materialisierte Occurrences von Daueraufträgen.
//   Parent-Regeln haben keinen Kalendertag und bleiben draußen.
// - Start/Abschließen laufen unverändert über den JobContext; das Gating
//   bleibt `canRunJobActions` (nicht neu gebaut, nicht gelockert).
//
// Aufbau:
//   Kopf   → Monat + Jahr, „Heute", Monat vor/zurück
//   Raster → MonthGrid (füllt die Restfläche, 4–6 Wochenzeilen)
//   Sheet  → DayAgendaSheet mit der VOLLSTÄNDIGEN Tagesliste
// ─────────────────────────────────────────────────────────────────

import { LoadingScreen, OfflineBanner } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { DayAgendaSheet } from "@/features/jobs/components/DayAgendaSheet";
import { MonthGrid } from "@/features/jobs/components/MonthGrid";
import { MonthYearPickerSheet } from "@/features/jobs/components/MonthYearPickerSheet";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  addMonths,
  buildDaySummaries,
  formatMonthLabel,
  groupJobsByDateKey,
  monthKeyOf,
} from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";
import { canRunJobActions } from "@/utils/jobAssignees";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const EMPTY_JOBS: never[] = [];

// ── Wisch-Schwellen ──────────────────────────────────────────────
// Zwei getrennte Werte, und das ist Absicht:
//   ACTIVATE = ab wann die Geste überhaupt als Wischen gilt (früh, damit
//              der Kalender sie der ScrollView abnehmen kann)
//   COMMIT   = ab wann der Monat tatsächlich wechselt (deutlich später)
// Dazwischen darf man sich frei bewegen und wieder zurückziehen, ohne dass
// etwas passiert. Ein Tipp bewegt sich um ~0 px und löst nie aus.
// 18 px statt knapper: sobald der Kalender die Geste übernimmt, bricht der
// Tipp auf der berührten Tageszelle ab. Ein etwas verwackelter Tipp (bis ~10 px)
// soll deshalb sicher noch als Tipp durchgehen. Später zu übernehmen ist hier
// unkritisch, weil die ScrollView faktisch nicht scrollt — ihr Inhalt füllt
// genau den Bildschirm, sie trägt nur das Pull-to-Refresh.
const SWIPE_ACTIVATE_DX = 18;
const SWIPE_COMMIT_DX = 56;
/** Waagerecht muss die Senkrechte klar dominieren (Faktor, nicht Differenz). */
const SWIPE_DOMINANCE = 1.6;
/** Selbst eine weite Waagerechte zählt nicht, wenn stark mitgescrollt wurde. */
const SWIPE_MAX_DY = 70;

export default function EmployeeJobsCalendarScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { role, profile } = useAuth();
  const { jobs, startJob, completeJob, loading, refreshJobs } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);
  const todayMonthKey = useMemo(() => monthKeyOf(new Date()), []);

  // Angezeigter Monat und ausgewählter Tag sind BEWUSST getrennter State.
  // In der alten Ansicht war der Monat aus der Auswahl abgeleitet — dadurch
  // verschob Blättern zwangsweise auch die Auswahl. In einer Vollbild-Ansicht
  // will man einen Monat ansehen können, ohne die Auswahl zu verlieren.
  const [monthKey, setMonthKey] = useState(todayMonthKey);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");

  // Kurzes Einschieben beim Monatswechsel — reine Rückmeldung „es hat
  // gewechselt". Bewusst NICHT an den Finger gekoppelt: eine mitlaufende
  // Animation müsste den Wisch abbrechen und zurückfedern können, und
  // korrekte Interaktion ist hier wichtiger als ein mitziehender Monat.
  const slide = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;

  const animateMonthChange = useCallback(
    (direction: 1 | -1) => {
      // Vorwärts kommt der neue Monat von rechts herein, rückwärts von links.
      slide.setValue(direction * 22);
      fade.setValue(0.55);
      Animated.parallel([
        Animated.timing(slide, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(fade, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [slide, fade],
  );

  // Merkt sich, dass wir selbst in ein Job-Detail navigiert haben. Beim
  // Zurückkommen bleibt der betrachtete Monat dann stehen (sonst wäre der
  // Weg „Tag im Dezember → Job öffnen → zurück" jedes Mal zurückgesetzt).
  // Kommt der Fokus dagegen von einem anderen Tab — etwa über „alle
  // anzeigen" aus der Übersicht —, startet der Kalender wieder auf heute.
  const cameFromDetailRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (cameFromDetailRef.current) {
        cameFromDetailRef.current = false;
        return;
      }
      setMonthKey(todayMonthKey);
      setSelectedKey(todayKey);
      setSheetOpen(false);
    }, [todayMonthKey, todayKey]),
  );

  // ── Daten ────────────────────────────────────────────────────
  // Nur konkrete Einzeltermine (echte Single-Jobs + Occurrences).
  // Parent-Recurring-Regeln fallen raus — zusätzlich zur serverseitigen RLS
  // als Client-Schutz, unverändert zur bisherigen Ansicht.
  const singleJobs = useMemo(
    () => jobs.filter((j) => j.jobType === "single"),
    [jobs],
  );

  // Einmal gruppieren statt 42-mal filtern (siehe utils/calendarMonth).
  // Die Gruppierung versorgt die Tages-Agenda; das Raster bekommt daraus
  // die verdichteten Zusammenfassungen.
  const jobsByDay = useMemo(() => groupJobsByDateKey(singleJobs), [singleJobs]);

  // Zahl + vorkommende Zustände je Tag — einmal vorberechnet, damit keine
  // Zelle im Render über Jobs iteriert.
  const summaries = useMemo(() => buildDaySummaries(jobsByDay), [jobsByDay]);

  const selectedJobs = useMemo(
    () => jobsByDay.get(selectedKey) ?? EMPTY_JOBS,
    [jobsByDay, selectedKey],
  );

  // Hat der angezeigte Monat überhaupt Aufträge? Nur für den dezenten
  // Hinweis unter dem Raster — das Raster selbst bleibt IMMER stehen.
  const monthHasJobs = useMemo(() => {
    for (const key of summaries.keys()) {
      if (key.startsWith(monthKey)) return true;
    }
    return false;
  }, [summaries, monthKey]);

  // ── Navigation ───────────────────────────────────────────────
  // Drei Wege, alle mit derselben Semantik: sie ändern NUR den angezeigten
  // Monat. Die Auswahl bleibt, wo sie ist — es wird nie ein Tag „erfunden".
  // Einzige Ausnahme ist „Heute", das ausdrücklich beides setzt.
  const goPrevMonth = useCallback(() => {
    setMonthKey((m) => addMonths(m, -1));
    animateMonthChange(-1);
  }, [animateMonthChange]);

  const goNextMonth = useCallback(() => {
    setMonthKey((m) => addMonths(m, 1));
    animateMonthChange(1);
  }, [animateMonthChange]);

  // Die Animation wird bewusst NEBEN dem State-Update ausgelöst und nicht in
  // der Updater-Funktion: React darf Updater doppelt ausführen (StrictMode),
  // ein Seiteneffekt darin liefe dann zweimal.
  const goToday = useCallback(() => {
    if (monthKey !== todayMonthKey) {
      animateMonthChange(monthKey < todayMonthKey ? 1 : -1);
    }
    setMonthKey(todayMonthKey);
    setSelectedKey(todayKey);
  }, [monthKey, todayMonthKey, todayKey, animateMonthChange]);

  // Sprung aus der Monats-/Jahresauswahl. Gleiche Regel wie Pfeile und
  // Wischen: nur der Monat wechselt, die Auswahl bleibt unangetastet.
  const handlePickMonth = useCallback(
    (next: string) => {
      if (next !== monthKey) animateMonthChange(monthKey < next ? 1 : -1);
      setMonthKey(next);
    },
    [monthKey, animateMonthChange],
  );

  // ── Wischen zwischen Monaten ─────────────────────────────────
  // PanResponder ist Bordmittel von React Native — keine neue Abhängigkeit,
  // und vor allem kein `GestureHandlerRootView` in der App-Wurzel (das
  // Projekt montiert keines; react-native-gesture-handler wäre ohne diesen
  // Eingriff gar nicht nutzbar).
  //
  // Warum auch die *Capture*-Variante gesetzt ist: die Tageszellen sind
  // TouchableOpacity und greifen den Responder bereits beim Berühren. Ohne
  // Capture käme ein Wisch, der auf einer Zelle beginnt, nie beim Kalender
  // an — also genau der Normalfall, weil das Raster den ganzen Bildschirm
  // füllt. Die Capture-Prüfung ist dieselbe strenge Bedingung, ein Tipp
  // erfüllt sie nie.
  const panResponder = useMemo(() => {
    const shouldClaim = (
      _e: GestureResponderEvent,
      g: PanResponderGestureState,
    ) =>
      Math.abs(g.dx) > SWIPE_ACTIVATE_DX &&
      Math.abs(g.dx) > Math.abs(g.dy) * SWIPE_DOMINANCE;

    return PanResponder.create({
      // Beim blossen Berühren NIE greifen — sonst wäre jeder Tag-Tipp
      // gefährdet.
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: shouldClaim,
      onMoveShouldSetPanResponderCapture: shouldClaim,
      // Einmal übernommen, nicht wieder abgeben (sonst zieht die ScrollView
      // die Geste mitten im Wisch zurück).
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        // Zu viel Senkrechte im Spiel → war eher ein schräges Scrollen.
        if (Math.abs(g.dy) > SWIPE_MAX_DY) return;
        if (g.dx <= -SWIPE_COMMIT_DX) goNextMonth();
        else if (g.dx >= SWIPE_COMMIT_DX) goPrevMonth();
      },
    });
  }, [goPrevMonth, goNextMonth]);

  // Tag auswählen. Ein Tag mit Aufträgen öffnet zusätzlich die vollständige
  // Tages-Agenda — für einen leeren Tag wäre ein Sheet nur ein Klick, den
  // man wieder wegtippen muss, deshalb bleibt es dort aus.
  const handleSelectDay = useCallback(
    (key: string) => {
      setSelectedKey(key);
      // Tag aus einem Nachbarmonat angetippt → in diesen Monat wechseln.
      const keyMonth = key.slice(0, 7);
      if (keyMonth !== monthKey) setMonthKey(keyMonth);
      if ((jobsByDay.get(key)?.length ?? 0) > 0) setSheetOpen(true);
    },
    [jobsByDay, monthKey],
  );

  // Job-Detail wird jetzt AUSSCHLIESSLICH aus der Tages-Agenda geöffnet —
  // im Raster gibt es keine antippbaren Auftragszeilen mehr.
  const handleOpenJob = useCallback((jobId: string) => {
    cameFromDetailRef.current = true;
    router.push(`/jobs/${jobId}`);
  }, []);

  // ── Aktionen (unverändert über den JobContext) ───────────────
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshJobs();
    } finally {
      setRefreshing(false);
    }
  }, [refreshJobs]);

  const handleStart = useCallback(
    async (jobId: string) => {
      setActionError("");
      try {
        await startJob(jobId);
      } catch (err: unknown) {
        setActionError(toUserMessage(err, "Job konnte nicht gestartet werden."));
      }
    },
    [startJob],
  );

  const handleComplete = useCallback(
    async (jobId: string) => {
      setActionError("");
      try {
        await completeJob(jobId);
      } catch (err: unknown) {
        setActionError(
          toUserMessage(err, "Job konnte nicht abgeschlossen werden."),
        );
      }
    },
    [completeJob],
  );

  const canRunActions = useCallback(
    (job: Parameters<typeof canRunJobActions>[0]) =>
      canRunJobActions(job, role, profile?.id),
    [role, profile?.id],
  );

  const isOnTodayMonth = monthKey === todayMonthKey;

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      {/* Der Kalender scrollt nicht (er füllt genau den Bildschirm) — die
          ScrollView ist ausschließlich Träger des Pull-to-Refresh, das die
          bisherige Listenansicht hatte. */}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
      >
        <OfflineBanner />

        {/* ── Kopf: Monat + Jahr, Heute, Blättern ── */}
        <View style={styles.header}>
          {/* Der Titel ist der Einstieg in die Monats-/Jahresauswahl — der
              schnelle Weg über mehrere Monate hinweg. Das Chevron macht
              sichtbar, dass hier etwas passiert; Rolle und Label machen es
              für den Screenreader eindeutig. */}
          <TouchableOpacity
            style={styles.monthTitleBtn}
            onPress={() => setPickerOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Monat und Jahr auswählen"
            accessibilityValue={{ text: formatMonthLabel(monthKey) }}
          >
            <Text style={styles.monthLabel} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              {formatMonthLabel(monthKey)}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.todayBtn, isOnTodayMonth && styles.todayBtnQuiet]}
            onPress={goToday}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Zu heute springen"
          >
            <Text style={styles.todayBtnText} maxFontSizeMultiplier={1.3}>
              Heute
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.navBtn}
            onPress={goPrevMonth}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Vorheriger Monat"
          >
            <Ionicons name="chevron-back" size={20} color={theme.colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.navBtn}
            onPress={goNextMonth}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Nächster Monat"
          >
            <Ionicons name="chevron-forward" size={20} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>

        {/* ── Monatsraster (füllt die Restfläche) ──
            Hier stand bis zuletzt ein „N überfällige Aufträge"-Banner. Es ist
            in dieser Ansicht bewusst ENTFALLEN: auf einem echten Datenbestand
            wurde daraus „63 überfällige Aufträge" in Warnfarbe — das
            dominierte den Bildschirm und machte aus einer Planungsansicht
            eine Mahnliste. Überfälliges ist Abarbeitung und gehört in die
            Übersicht bzw. den kommenden Jobs-Tab.
            Es geht dabei nichts verloren: die Berechnung war rein lokal in
            diesem Screen. Die geteilte Überfällig-Logik (`getOverdueOccurrences`
            in services/jobs/jobs.service.ts) und ihre Admin-Flächen
            (AdminScheduleScreen, AdminDashboardScreen) bleiben unangetastet. */}
        <Animated.View
          style={[
            styles.gridWrap,
            { opacity: fade, transform: [{ translateX: slide }] },
          ]}
          {...panResponder.panHandlers}
        >
          <MonthGrid
            monthKey={monthKey}
            selectedKey={selectedKey}
            todayKey={todayKey}
            summaries={summaries}
            onSelectDay={handleSelectDay}
          />
        </Animated.View>

        {/* Leerer Monat: der Kalender bleibt stehen, es kommt nur eine
            ruhige Zeile dazu — kein EmptyState, der das Raster ersetzt. */}
        {!monthHasJobs ? (
          <Text style={styles.emptyMonthHint} numberOfLines={2}>
            In diesem Monat sind dir keine Aufträge zugewiesen.
          </Text>
        ) : null}
      </ScrollView>

      <MonthYearPickerSheet
        visible={pickerOpen}
        monthKey={monthKey}
        onSelect={handlePickMonth}
        onClose={() => setPickerOpen(false)}
      />

      <DayAgendaSheet
        visible={sheetOpen}
        dayKey={selectedKey}
        jobs={selectedJobs}
        onClose={() => setSheetOpen(false)}
        onOpenJob={handleOpenJob}
        canRunActions={canRunActions}
        onStart={handleStart}
        onComplete={handleComplete}
        errorMessage={actionError}
        onDismissError={() => setActionError("")}
      />
    </SafeAreaView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    flex: {
      flex: 1,
    },
    // flexGrow statt fester Höhe: der Inhalt füllt mindestens den Bildschirm,
    // damit MonthGrid seine `flex: 1`-Restfläche bekommt.
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      // Größer als vorher (sm): der Monat soll ruhig wirken, und das Raster
      // gibt die Höhe über flex:1 bereitwillig her.
      gap: theme.spacing.md,
    },

    // ── Kopfzeile
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.xs,
    },
    // Titel + Chevron als ein Tippziel; flex:1 schiebt die restlichen
    // Bedienelemente wie bisher nach rechts.
    monthTitleBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 4,
    },
    monthLabel: {
      flexShrink: 1,
      fontSize: theme.typography.size.xl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      textTransform: "capitalize",
    },
    todayBtn: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 7,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    // Auf dem aktuellen Monat bleibt „Heute" bedienbar (es setzt dann noch
    // die Auswahl zurück), tritt optisch aber zurück.
    todayBtnQuiet: {
      borderColor: theme.colors.outlineVariant,
    },
    todayBtnText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.primary,
    },
    navBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
    },

    // Träger der Wischgeste und der Wechsel-Animation. Muss flex:1 haben,
    // damit das Raster wie bisher die Restfläche bekommt.
    gridWrap: {
      flex: 1,
    },

    emptyMonthHint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
  });
}
