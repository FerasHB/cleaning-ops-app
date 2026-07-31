// features/jobs/RecurringRuleDetailScreen.tsx
// Eigene Detailansicht für eine Dauerauftrags-REGEL (job_type='recurring',
// parent_job_id IS NULL).
//
// WARUM EIN EIGENER SCREEN: bisher lief eine Regel durch den JobDetailScreen,
// also durch die Ansicht eines ausführbaren Termins, bei der einzelne Blöcke
// per `isParentRule` abgeschaltet wurden. Ergebnis: die Terminliste — der
// eigentliche Inhalt einer Regel — stand an neunter Stelle unter sechs
// Karten, der Aktionsbereich rendete einen leeren Container, und es hingen
// Fotos an einer Vorlage. Die Reihenfolge hier folgt stattdessen der Frage
// „läuft die Regel, und was kommt als Nächstes?".
//
// UNVERÄNDERT ÜBERNOMMEN aus dem JobDetailScreen (bewusst wortgleich, damit
// sich das Verhalten nicht verschiebt):
//   • Aktionsmenü Bearbeiten / De-Aktivieren / Löschen samt Bestätigungstexten
//   • setRecurringRuleActive → Regel neu lesen → Termine neu laden
//   • deleteJob → router.back(), Fehler als ErrorBanner statt stillem Scheitern
//   • das Schließen des Sheets VOR der Aktion (250 ms), weil iOS einen Alert
//     oder Navigations-Push während der Modal-Animation verschluckt
//   • Termine bei JEDEM Fokussieren neu laden (der Edit-Screen liegt im
//     Root-Stack und unmountet diesen Screen nicht)
//
// BERECHTIGUNGEN: unverändert. Termine, Aktionsmenü und der Alt-Kommentar-
// Abschnitt sind Admin-Sache; Mitarbeitende sahen hier noch nie Termine oder
// ein Menü und sehen sie weiterhin nicht.

import {
  ActionMenuSheet,
  ErrorBanner,
  OfflineBanner,
  type ActionMenuItem,
} from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobs } from "@/context/JobContext";
import { AssignedEmployeesCard } from "@/features/jobs/components/AssignedEmployeesCard";
import { JobDetailHeader } from "@/features/jobs/components/JobDetailHeader";
import { JobNotesCard } from "@/features/jobs/components/JobNotesCard";
import { JobTimelineCard } from "@/features/jobs/components/JobTimelineCard";
import { RuleHeader } from "@/features/jobs/components/RuleHeader";
import { RuleLegacyComments } from "@/features/jobs/components/RuleLegacyComments";
import { RuleOccurrenceAgenda } from "@/features/jobs/components/RuleOccurrenceAgenda";
import { RuleScheduleSummary } from "@/features/jobs/components/RuleScheduleSummary";
import { RuleStatusCard } from "@/features/jobs/components/RuleStatusCard";
import { useAppTheme } from "@/hooks/useAppTheme";
import {
  getJobById,
  getJobOccurrences,
  setRecurringRuleActive,
} from "@/services/jobs/jobs.service";
import type { Job } from "@/types/job";
import { formatDateISO } from "@/utils/date";
import { getAssignees } from "@/utils/jobAssignees";
import { buildOccurrenceAgenda } from "@/utils/occurrenceAgenda";
import { deriveRuleHealth } from "@/utils/recurringRule";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, StatusBar, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Props = {
  /** Die Parent-Regel. Der Aufrufer hat bereits geprüft, dass es eine ist. */
  rule: Job;
  isAdmin: boolean;
  /**
   * Wird nach dem (De-)Aktivieren mit der frisch gelesenen Regel gerufen.
   * Der aufrufende JobDetailScreen hält den Direktabruf-State — Regeln liegen
   * meist außerhalb des Context-Fensters.
   */
  onRuleRefreshed: (job: Job) => void;
};

export default function RecurringRuleDetailScreen({
  rule,
  isAdmin,
  onRuleRefreshed,
}: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { employees, deleteJob } = useJobs();

  const todayKey = useMemo(() => formatDateISO(new Date()) ?? "", []);

  const [occurrences, setOccurrences] = useState<Job[]>([]);
  const [occurrencesLoading, setOccurrencesLoading] = useState(false);
  // Erst nach dem ersten abgeschlossenen Ladevorgang darf aus „keine Termine
  // im Array" eine Warnung werden — sonst blitzt beim Öffnen kurz
  // „Keine Termine generiert" auf, obwohl nur noch geladen wird.
  const [occurrencesLoaded, setOccurrencesLoaded] = useState(false);

  const [actionError, setActionError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);

  const ruleId = rule.id;

  const loadOccurrences = useCallback(async () => {
    // Termine sind wie bisher ausschließlich eine Admin-Ansicht.
    if (!isAdmin) return;
    setOccurrencesLoading(true);
    try {
      setOccurrences(await getJobOccurrences(ruleId));
    } catch {
      setOccurrences([]);
    } finally {
      setOccurrencesLoading(false);
      setOccurrencesLoaded(true);
    }
  }, [ruleId, isAdmin]);

  useFocusEffect(
    useCallback(() => {
      loadOccurrences();
    }, [loadOccurrences]),
  );

  // Kennzahlen der Termine — dieselbe reine Funktion, die auch die Agenda
  // benutzt (identische Aufteilung, keine zweite Wahrheit).
  const agendaSummary = useMemo(
    () => buildOccurrenceAgenda(occurrences, todayKey),
    [occurrences, todayKey],
  );

  // Aktiv-Status über ALLE Zugewiesenen: false, sobald einer deaktiviert ist;
  // null, wenn keine Auskunft vorliegt. Für Nicht-Admins bewusst immer null —
  // die Mitarbeiterliste ist dort nicht verlässlich befüllt und eine
  // „Mitarbeiter inaktiv"-Warnung wäre dann geraten statt belegt.
  const assigneeActive = useMemo(() => {
    if (!isAdmin) return null;
    const activeById = new Map<string, boolean>();
    for (const employee of employees) {
      activeById.set(employee.id, employee.isActive !== false);
    }
    const states = getAssignees(rule)
      .map((assignee) =>
        assignee.employeeId ? activeById.get(assignee.employeeId) : undefined,
      )
      .filter((value): value is boolean => typeof value === "boolean");
    if (states.length === 0) return null;
    return states.every((active) => active);
  }, [isAdmin, employees, rule]);

  const health = useMemo(
    () =>
      deriveRuleHealth(
        rule,
        {
          // Vor dem ersten Ladevorgang optimistisch — siehe occurrencesLoaded.
          hasOccurrences: !occurrencesLoaded || agendaSummary.counts.upcoming > 0,
          nextOccurrenceDate: agendaSummary.nextUp[0]?.date?.slice(0, 10) ?? null,
        },
        assigneeActive,
        todayKey,
      ),
    [rule, occurrencesLoaded, agendaSummary, assigneeActive, todayKey],
  );

  // ── Aktionen (unverändert gegenüber JobDetailScreen)
  const handleEdit = useCallback(() => {
    router.push(`/jobs/${ruleId}/edit`);
  }, [ruleId]);

  const handleToggleRuleActive = useCallback(async () => {
    setActionError("");
    setRuleBusy(true);
    try {
      await setRecurringRuleActive(ruleId, !(rule.isActive ?? true));
      // Regel + Termine neu laden: das Deaktivieren entfernt serverseitig
      // zukünftige offene Termine.
      const fresh = await getJobById(ruleId);
      if (fresh) onRuleRefreshed(fresh);
      await loadOccurrences();
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Aktion fehlgeschlagen.",
      );
    } finally {
      setRuleBusy(false);
    }
  }, [ruleId, rule.isActive, onRuleRefreshed, loadOccurrences]);

  const handleDeleteRule = useCallback(() => {
    Alert.alert(
      "Dauerauftrag löschen",
      "Regeln mit bereits gestarteten oder abgeschlossenen Terminen können aus Sicherheitsgründen nicht gelöscht werden. Fortfahren?",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Löschen",
          style: "destructive",
          onPress: async () => {
            setActionError("");
            setRuleBusy(true);
            try {
              await deleteJob(ruleId);
              router.back();
            } catch (err: unknown) {
              // Der DB-Guard lehnt Löschungen mit geschützter Historie ab —
              // Meldung sichtbar machen statt still zu scheitern.
              setActionError(
                err instanceof Error
                  ? err.message
                  : "Löschen nicht möglich (geschützte Historie).",
              );
            } finally {
              setRuleBusy(false);
            }
          },
        },
      ],
    );
  }, [deleteJob, ruleId]);

  // Aktion erst nach dem Schließen des Sheets auslösen — ein Alert oder
  // Navigations-Push während der Modal-Animation wird auf iOS verschluckt.
  const handleMenuSelect = useCallback(
    (key: string) => {
      setMenuOpen(false);
      setTimeout(() => {
        if (key === "edit") handleEdit();
        else if (key === "toggle") handleToggleRuleActive();
        else if (key === "delete") handleDeleteRule();
      }, 250);
    },
    [handleEdit, handleToggleRuleActive, handleDeleteRule],
  );

  const ruleActive = rule.isActive ?? true;
  const menuItems: ActionMenuItem[] = useMemo(
    () => [
      { key: "edit", label: "Bearbeiten", icon: "create-outline" },
      {
        key: "toggle",
        label: ruleActive ? "Deaktivieren" : "Aktivieren",
        icon: ruleActive ? "pause-outline" : "play-outline",
      },
      {
        key: "delete",
        label: "Löschen",
        icon: "trash-outline",
        destructive: true,
      },
    ],
    [ruleActive],
  );

  // Eine Regel wird nie ausgeführt — Start-/Abschlusszeiten auf der Regel-Zeile
  // sind eine Datenanomalie und MÜSSEN sichtbar bleiben (siehe Kopfkommentar
  // von JobTimelineCard). showPlaceholder=false unterdrückt nur den
  // „noch nicht gestartet"-Platzhalter, der für eine Vorlage sinnlos wäre.
  const hasTimelineAnomaly = !!rule.startedAt || !!rule.completedAt;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      <JobDetailHeader
        showMenu={isAdmin}
        menuBusy={ruleBusy}
        onMenuPress={() => setMenuOpen(true)}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* 1 — Was ist das, und wie steht es darum? */}
        <RuleHeader rule={rule} health={health} />

        <OfflineBanner />
        {actionError ? (
          <ErrorBanner
            message={actionError}
            onDismiss={() => setActionError("")}
          />
        ) : null}

        {/* 2 — Erklärung, sobald der Zustand erklärungsbedürftig ist */}
        <RuleStatusCard health={health} />

        {/* 3 — Die Wiederholung selbst */}
        <RuleScheduleSummary
          rule={rule}
          horizonDate={occurrencesLoaded ? agendaSummary.horizonDate : null}
        />

        {/* 4 — Wer ist zugewiesen? */}
        <AssignedEmployeesCard job={rule} />

        {/* 5 — Notizen, nur wenn vorhanden */}
        {rule.notes ? <JobNotesCard notes={rule.notes} /> : null}

        {/* 6 — Anomalie: eine Regel mit Start-/Abschlusszeit */}
        {hasTimelineAnomaly ? (
          <JobTimelineCard job={rule} showPlaceholder={false} />
        ) : null}

        {/* 7 — Die Termine (Admin) */}
        {isAdmin ? (
          <RuleOccurrenceAgenda
            occurrences={occurrences}
            loading={occurrencesLoading && !occurrencesLoaded}
            rule={rule}
            onOpen={(occurrence) => router.push(`/jobs/${occurrence.id}`)}
          />
        ) : null}

        {/* 8 — Altbestand: Kommentare direkt an der Regel (nur lesen) */}
        {isAdmin ? <RuleLegacyComments jobId={ruleId} /> : null}

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>

      <ActionMenuSheet
        visible={menuOpen}
        title={rule.customerName}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
        onSelect={handleMenuSelect}
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
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xl,
      gap: theme.spacing.md,
    },
  });
}
