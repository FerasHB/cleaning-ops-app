// features/jobs/AdminJobsCalendarScreen.tsx
// ─────────────────────────────────────────────────────────────────
// Admin-Kalender: firmenweite Planungs-Übersicht über einen Monat.
//
// Bewusst KEINE Kopie des Mitarbeiter-Kalenders (EmployeeJobsCalendarScreen):
// dessen Datenquelle (`useJobs().jobs`) ist für Employees RLS-begrenzt auf
// eigene Aufträge und für Admins ein fixes −30/+60-Tage-Kompatibilitäts-
// fenster (siehe JobContext) — für eine firmenweite Monatsansicht ungeeignet.
//
// Datenquelle hier: `getScheduleOccurrences({ from, to })`, GENAU für den
// sichtbaren Rasterbereich (inkl. Vor-/Nachlauftage aus Nachbarmonaten),
// dieselbe Funktion, die bereits AdminScheduleScreen nutzt — kein neuer
// Backend-Code, keine Migration.
//
// Mitarbeiter- UND Status-Filter laufen rein clientseitig auf den bereits
// geladenen Monatsdaten — ein Umschalten löst NIE einen Request aus, nur der
// Monatswechsel selbst tut das.
//
// Kein eigener Supabase-Realtime-Kanal: JobContext hat bereits GENAU EINEN
// "jobs"-Kanal, der bei jeder Änderung (und jeder lokalen Admin-Aktion
// anderswo in der App) `refreshJobs()` aufruft und damit IMMER ein neues
// `jobs`-Array liefert. Dieser Screen beobachtet dieses Array nur als Signal
// und lädt NICHT bei jeder Referenzänderung blind neu — er vergleicht erst,
// ob sich innerhalb des sichtbaren Rasterbereichs überhaupt etwas geändert
// hat (Status/Datum/Zuweisung), und lädt nur dann nach. Das deckt Änderungen
// zuverlässig ab, solange der angezeigte Monat das feste JobContext-Fenster
// überschneidet (der Normalfall: aktueller Monat und Nachbarmonate) — für
// weiter entfernte Monate bleibt es bei Fokus-/Pull-to-Refresh-Aktualisierung
// (bewusst dokumentierte Grenze, siehe PR-Beschreibung).
// ─────────────────────────────────────────────────────────────────

import { ErrorBanner, LoadingScreen } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobs } from "@/context/JobContext";
import {
  AbsenceFilterRow,
  absenceSelectionLabel,
  type AbsenceSelection,
} from "@/features/jobs/components/AbsenceFilterRow";
import { DayAgendaSheet } from "@/features/jobs/components/DayAgendaSheet";
import {
  EmployeeFilterControl,
  employeeSelectionLabel,
  type EmployeeSelection,
} from "@/features/jobs/components/EmployeeFilterControl";
import { MonthGrid } from "@/features/jobs/components/MonthGrid";
import { MonthYearPickerSheet } from "@/features/jobs/components/MonthYearPickerSheet";
import {
  StatusFilterRow,
  statusSelectionLabel,
  type StatusSelection,
} from "@/features/jobs/components/StatusFilterRow";
import { useAppTheme } from "@/hooks/useAppTheme";
import { getCompanyAbsencesInRange } from "@/services/absences/adminAbsences.service";
import { getScheduleOccurrences } from "@/services/jobs/jobs.service";
import type { Absence } from "@/types/absence";
import type { Job } from "@/types/job";
import {
  absenceTypesForDay,
  buildAbsenceDayIndex,
} from "@/utils/absenceCalendarMarkers";
import {
  addMonths,
  buildDaySummaries,
  buildMonthMatrix,
  formatMonthLabel,
  groupJobsByDateKey,
  monthKeyOf,
} from "@/utils/calendarMonth";
import { formatDateISO } from "@/utils/date";
import { isAssignedTo, isUnassigned } from "@/utils/jobAssignees";
import { toUserMessage } from "@/utils/userMessages";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const EMPTY_JOBS: never[] = [];
const EMPTY_ABSENCES: never[] = [];
// Deckt die größte bekannte Firma (≈90 Aufträge/60-Tage-Fenster, Stand
// Prod-Stichprobe) großzügig ab — dient nur als Sicherheitsdeckel, kein
// erwarteter Regelfall. Wird erreicht → Hinweis statt stiller Untertreibung.
const OCCURRENCE_LIMIT = 500;
const REALTIME_ECHO_DEBOUNCE_MS = 300;

export default function AdminJobsCalendarScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { employees, jobs: contextJobs } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);
  const todayMonthKey = useMemo(() => monthKeyOf(new Date()), []);

  const [monthKey, setMonthKey] = useState(todayMonthKey);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [employeeSel, setEmployeeSel] = useState<EmployeeSelection>("all");
  const [statusSel, setStatusSel] = useState<StatusSelection>("all");
  const [absenceSel, setAbsenceSel] = useState<AbsenceSelection>("all");

  const [rawJobs, setRawJobs] = useState<Job[]>([]);
  const [rawAbsences, setRawAbsences] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [possiblyIncomplete, setPossiblyIncomplete] = useState(false);

  const loadInProgressRef = useRef(false);

  // Wie EmployeeJobsCalendarScreen: „von einem Job-Detail zurück" behält den
  // betrachteten Monat, „von einem anderen Tab" springt auf heute zurück.
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

  // ── Datumsbereich des sichtbaren Rasters (inkl. Nachbarmonats-Tage) ──
  const gridRange = useMemo(() => {
    const weeks = buildMonthMatrix(monthKey);
    return {
      from: weeks[0][0].key,
      to: weeks[weeks.length - 1][6].key,
    };
  }, [monthKey]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (loadInProgressRef.current) return;
      loadInProgressRef.current = true;
      if (!isRefresh) setLoading(true);
      setError(null);
      try {
        // Genau ein Job- und EIN Abwesenheits-Query für den sichtbaren
        // Rasterbereich (Phase D) — keine Abfrage je Tag/Mitarbeiter.
        const [items, absenceItems] = await Promise.all([
          getScheduleOccurrences({
            from: gridRange.from,
            to: gridRange.to,
            limit: OCCURRENCE_LIMIT,
          }),
          getCompanyAbsencesInRange({
            from: gridRange.from,
            to: gridRange.to,
            activeOnly: true,
          }),
        ]);
        setRawJobs(items);
        setPossiblyIncomplete(items.length >= OCCURRENCE_LIMIT);
        setRawAbsences(absenceItems);
      } catch (err: unknown) {
        setError(toUserMessage(err, "Kalender konnte nicht geladen werden."));
      } finally {
        loadInProgressRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [gridRange],
  );

  // Lädt bei jedem Monatswechsel neu (gridRange ändert sich → load ändert sich).
  useEffect(() => {
    load();
  }, [load]);

  // ── Realtime-Echo: kein eigener Kanal, siehe Dateikopf ──
  const prevContextJobsRef = useRef<Job[]>([]);
  const isFirstContextJobsRunRef = useRef(true);

  useEffect(() => {
    const prev = prevContextJobsRef.current;
    const curr = contextJobs;
    prevContextJobsRef.current = curr;

    if (isFirstContextJobsRunRef.current) {
      isFirstContextJobsRunRef.current = false;
      return;
    }
    if (prev === curr) return;

    // Signatur je Job INNERHALB des sichtbaren Rasterbereichs — nur das kann
    // die aktuelle Ansicht überhaupt betreffen.
    const signatureOf = (list: Job[]): Map<string, string> => {
      const map = new Map<string, string>();
      for (const job of list) {
        if (!job.date || job.date < gridRange.from || job.date > gridRange.to) {
          continue;
        }
        const assigneeIds = job.assignees
          .map((a) => a.employeeId ?? "")
          .sort()
          .join(",");
        map.set(job.id, `${job.status}|${job.date}|${assigneeIds}`);
      }
      return map;
    };

    const prevSig = signatureOf(prev);
    const currSig = signatureOf(curr);

    let changed = prevSig.size !== currSig.size;
    if (!changed) {
      for (const [id, sig] of currSig) {
        if (prevSig.get(id) !== sig) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;

    const timeout = setTimeout(() => {
      load(true);
    }, REALTIME_ECHO_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [contextJobs, gridRange, load]);

  // ── Filter: rein clientseitig auf den bereits geladenen Monatsdaten ──
  const visibleJobs = useMemo(() => {
    return rawJobs.filter((job) => {
      if (statusSel !== "all" && job.status !== statusSel) return false;
      if (employeeSel === "all") return true;
      if (employeeSel === "unassigned") return isUnassigned(job);
      return isAssignedTo(job, employeeSel);
    });
  }, [rawJobs, employeeSel, statusSel]);

  const jobsByDay = useMemo(() => groupJobsByDateKey(visibleJobs), [visibleJobs]);
  const summaries = useMemo(() => buildDaySummaries(jobsByDay), [jobsByDay]);
  const selectedJobs = useMemo(
    () => jobsByDay.get(selectedKey) ?? EMPTY_JOBS,
    [jobsByDay, selectedKey],
  );

  // ── Phase D: Abwesenheits-Filter — rein clientseitig, wie Mitarbeiter-/
  // Status-Filter. Der Mitarbeiter-Filter gilt AUCH für Abwesenheits-Zeilen
  // (Anforderung: "Employee = Lena + Absence = Urlaub" zeigt nur Lenas
  // Urlaub). "unassigned" hat für Abwesenheiten keine Entsprechung — zeigt
  // dann bewusst keine Abwesenheiten.
  const visibleAbsences = useMemo(() => {
    return rawAbsences.filter((absence) => {
      if (absenceSel === "vacation" && absence.type !== "vacation") return false;
      if (absenceSel === "sickness" && absence.type !== "sickness") return false;
      if (employeeSel === "all") return true;
      if (employeeSel === "unassigned") return false;
      return absence.employeeId === employeeSel;
    });
  }, [rawAbsences, absenceSel, employeeSel]);

  const absencesByDay = useMemo(
    () => buildAbsenceDayIndex(visibleAbsences, gridRange),
    [visibleAbsences, gridRange],
  );
  const absenceMarkers = useMemo(() => {
    const map = new Map<string, ReturnType<typeof absenceTypesForDay>>();
    for (const [key, list] of absencesByDay) {
      map.set(key, absenceTypesForDay(list));
    }
    return map;
  }, [absencesByDay]);
  const selectedAbsences = useMemo(
    () => absencesByDay.get(selectedKey) ?? EMPTY_ABSENCES,
    [absencesByDay, selectedKey],
  );

  const monthHasJobs = useMemo(() => {
    for (const key of summaries.keys()) {
      if (key.startsWith(monthKey)) return true;
    }
    return false;
  }, [summaries, monthKey]);

  // Getrennt von hasActiveFilter (steuert nur die entfernbaren Filter-Chips):
  // der Abwesenheits-Filter beeinflusst NIE die Auftragsliste (siehe
  // AbsenceFilterRow-Kommentar) — "Keine Aufträge für diesen Tag/Monat mit
  // der aktuellen Filterauswahl" darf also nicht allein wegen absenceSel
  // erscheinen, das wäre irreführend.
  const hasJobFilter = employeeSel !== "all" || statusSel !== "all";
  const hasActiveFilter = hasJobFilter || absenceSel !== "all";

  // Nur aktive Mitarbeiter zur Auswahl — deckungsgleich mit der Vorauswahl in
  // app/(admin-tabs)/employees.tsx.
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false),
    [employees],
  );

  const employeeLabel = useMemo(
    () => employeeSelectionLabel(employeeSel, employees),
    [employeeSel, employees],
  );
  const statusLabel = useMemo(() => statusSelectionLabel(statusSel), [statusSel]);
  const absenceLabel = useMemo(() => absenceSelectionLabel(absenceSel), [absenceSel]);

  // ── Navigation (identisch zum Mitarbeiter-Kalender: kein Swipe) ──
  const goPrevMonth = useCallback(() => setMonthKey((m) => addMonths(m, -1)), []);
  const goNextMonth = useCallback(() => setMonthKey((m) => addMonths(m, 1)), []);
  const goToday = useCallback(() => {
    setMonthKey(todayMonthKey);
    setSelectedKey(todayKey);
  }, [todayMonthKey, todayKey]);
  const handlePickMonth = useCallback((next: string) => setMonthKey(next), []);

  const handleSelectDay = useCallback(
    (key: string) => {
      setSelectedKey(key);
      const keyMonth = key.slice(0, 7);
      if (keyMonth !== monthKey) setMonthKey(keyMonth);
      // Phase D: die Tages-Agenda öffnet auch für einen Tag OHNE Aufträge,
      // wenn er Abwesenheiten hat — sonst wäre ein reiner Abwesenheits-Tag
      // nie einsehbar.
      const hasJobs = (jobsByDay.get(key)?.length ?? 0) > 0;
      const hasAbsences = (absencesByDay.get(key)?.length ?? 0) > 0;
      if (hasJobs || hasAbsences) setSheetOpen(true);
    },
    [jobsByDay, absencesByDay, monthKey],
  );

  const handleOpenJob = useCallback((jobId: string) => {
    cameFromDetailRef.current = true;
    setSheetOpen(false);
    router.push(`/jobs/${jobId}`);
  }, []);

  // Phase D: Tippen auf eine Abwesenheits-Zeile → Mitarbeiter-Detail (dort
  // liegt auch die "Job zuweisen"-Aktion — kein neuer, eigener Ziel-Screen
  // für Phase D). Kein employeeId → Konto gelöscht, dann nicht antippbar
  // (siehe DayAgendaSheet: onOpenAbsence bleibt für diese Zeile undefiniert
  // wäre sauberer, aber Absence.employeeId ist hier bereits geprüft nötig).
  const handleOpenAbsence = useCallback((absence: Absence) => {
    if (!absence.employeeId) return;
    cameFromDetailRef.current = true;
    setSheetOpen(false);
    router.push(`/employees/${absence.employeeId}`);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  // Admin führt Aufträge nie selbst aus — canRunJobActions verlangt serverseitig
  // role='employee', hier also bewusst statt einer echten Prüfung: nie.
  const canRunActions = useCallback(() => false, []);
  const noopAction = useCallback(() => {}, []);

  const dayAgendaEmptyMessage = hasJobFilter
    ? "Keine Aufträge für diesen Tag mit der aktuellen Filterauswahl."
    : "Keine Aufträge an diesem Tag.";

  const isOnTodayMonth = monthKey === todayMonthKey;

  if (loading) return <LoadingScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

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
        {error ? (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        ) : null}

        {/* ── Kopf: Monat + Jahr, Heute, Blättern ── */}
        <View style={styles.header}>
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

        {/* ── Filter: Mitarbeiter-Icon-Button + Status-Chips ── */}
        <View style={styles.filterRow}>
          <EmployeeFilterControl
            value={employeeSel}
            onChange={setEmployeeSel}
            employees={activeEmployees}
          />
          <View style={styles.statusFilterWrap}>
            <StatusFilterRow value={statusSel} onChange={setStatusSel} />
          </View>
        </View>

        {/* ── Phase D: Abwesenheits-Filter — eigene Zeile, GETRENNT vom
            Mitarbeiter-/Status-Filter oben. Steuert ausschließlich
            Abwesenheits-Marker/-Agenda-Zeilen, blendet nie Aufträge aus
            (siehe AbsenceFilterRow-Kommentar). ── */}
        <View style={styles.absenceFilterRow}>
          <AbsenceFilterRow value={absenceSel} onChange={setAbsenceSel} />
        </View>

        {/* ── Aktive Filter: entfernbare Chips ── */}
        {hasActiveFilter ? (
          <View style={styles.activeFilterRow}>
            {employeeSel !== "all" ? (
              <View style={styles.activeFilterChip}>
                <Ionicons name="people" size={13} color={theme.colors.onPrimaryContainer} />
                <Text style={styles.activeFilterText} numberOfLines={1}>
                  Mitarbeiter: {employeeLabel}
                </Text>
                <TouchableOpacity
                  onPress={() => setEmployeeSel("all")}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Mitarbeiter-Filter ${employeeLabel} entfernen`}
                >
                  <Ionicons name="close" size={14} color={theme.colors.onPrimaryContainer} />
                </TouchableOpacity>
              </View>
            ) : null}

            {statusSel !== "all" ? (
              <View style={styles.activeFilterChip}>
                <Ionicons
                  name="ellipse"
                  size={9}
                  color={theme.colors.onPrimaryContainer}
                />
                <Text style={styles.activeFilterText} numberOfLines={1}>
                  Status: {statusLabel}
                </Text>
                <TouchableOpacity
                  onPress={() => setStatusSel("all")}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Status-Filter ${statusLabel} entfernen`}
                >
                  <Ionicons name="close" size={14} color={theme.colors.onPrimaryContainer} />
                </TouchableOpacity>
              </View>
            ) : null}

            {absenceSel !== "all" ? (
              <View style={styles.activeFilterChip}>
                <Ionicons
                  name={absenceSel === "vacation" ? "sunny-outline" : "medkit-outline"}
                  size={13}
                  color={theme.colors.onPrimaryContainer}
                />
                <Text style={styles.activeFilterText} numberOfLines={1}>
                  Abwesenheit: {absenceLabel}
                </Text>
                <TouchableOpacity
                  onPress={() => setAbsenceSel("all")}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Abwesenheits-Filter ${absenceLabel} entfernen`}
                >
                  <Ionicons name="close" size={14} color={theme.colors.onPrimaryContainer} />
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── Monatsraster ── */}
        <MonthGrid
          monthKey={monthKey}
          selectedKey={selectedKey}
          todayKey={todayKey}
          summaries={summaries}
          absenceMarkers={absenceMarkers}
          onSelectDay={handleSelectDay}
        />

        {!monthHasJobs ? (
          <Text style={styles.emptyMonthHint} numberOfLines={2}>
            {hasJobFilter
              ? "Keine Aufträge für die aktuelle Filterauswahl in diesem Monat."
              : "In diesem Monat sind keine Aufträge geplant."}
          </Text>
        ) : null}

        {possiblyIncomplete ? (
          <Text style={styles.capHint} numberOfLines={2}>
            Sehr viele Aufträge in diesem Monat — Anzeige möglicherweise nicht
            vollständig.
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
        onStart={noopAction}
        onComplete={noopAction}
        showEmployeeName
        emptyMessage={dayAgendaEmptyMessage}
        absences={selectedAbsences}
        onOpenAbsence={handleOpenAbsence}
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
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      gap: theme.spacing.sm,
    },

    // ── Kopfzeile (identisch zum Mitarbeiter-Kalender)
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.xs,
    },
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

    // ── Filterzeile: Mitarbeiter-Button + Status-Chips
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
    },
    statusFilterWrap: {
      flex: 1,
    },

    // ── Phase D: Abwesenheits-Filter — eigene Zeile unter Mitarbeiter/Status
    absenceFilterRow: {
      paddingHorizontal: theme.spacing.xs,
    },

    // ── Aktive Filter: entfernbare Chips (Muster aus AdminScheduleScreen)
    activeFilterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.xs,
    },
    activeFilterChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 6,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.primaryContainer,
    },
    activeFilterText: {
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onPrimaryContainer,
    },

    emptyMonthHint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },
    capHint: {
      textAlign: "center",
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      paddingHorizontal: theme.spacing.md,
    },
  });
}
