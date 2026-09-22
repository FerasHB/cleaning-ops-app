// features/jobs/JobDetailScreen.tsx
// Detail-Ansicht eines AUSFÜHRBAREN Jobs (Einzeltermin oder generierter
// Termin) mit allen Infos und kontextabhängigen Aktionen. Aktionen
// (Start/Complete/Edit) nutzen weiter den bestehenden JobContext — keine
// Änderungen an Supabase-/Offline-Sync-Logik.
//
// "Job Details 2.0": die Präsentationsschicht ist auf kleine, reine
// Anzeige-Komponenten in features/jobs/components/ aufgeteilt (siehe unten).
// Dieser Screen bleibt der Orchestrator: er hält Daten/State/Handler und
// entscheidet NUR, WELCHE Komponente wann sichtbar ist — die Berechtigungs-
// und Aktions-Logik selbst ist unverändert gegenüber der Vorversion.
//
// PARENT-REGELN LAUFEN HIER NICHT MEHR DURCH: eine Dauerauftrags-Regel ist
// eine Vorlage, kein ausführbarer Termin. Sie wird an derselben Route
// (/jobs/[id]) an RecurringRuleDetailScreen übergeben — die Route und damit
// jeder bestehende Deep-Link bleiben unverändert. Dadurch entfallen hier
// sämtliche `isParentRule`-Sonderfälle.

import {
  EmptyState,
  ErrorBanner,
  LoadingScreen,
  OfflineBanner,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useSessionWorkedTime } from "@/hooks/useSessionWorkedTime";
import { deriveAssignmentWorkUi, hasActiveAssignmentSession } from "@/utils/assignmentWorkUi";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import RecurringRuleDetailScreen from "@/features/jobs/RecurringRuleDetailScreen";
import { AssignedEmployeesCard } from "@/features/jobs/components/AssignedEmployeesCard";
import {
  TimeCorrectionSheet,
  type TimeCorrectionTarget,
} from "@/features/timesheets/components/TimeCorrectionSheet";
import { ForceCompleteSheet } from "@/features/jobs/components/ForceCompleteSheet";
import { JobActionFooter } from "@/features/jobs/components/JobActionFooter";
import { SessionWorkStatus } from "@/features/jobs/components/SessionWorkStatus";
import { WorkReconciliationNotice } from "@/features/jobs/components/WorkReconciliationNotice";
import { JobComments } from "@/features/jobs/components/JobComments";
import { JobDetailHeader } from "@/features/jobs/components/JobDetailHeader";
import { JobLocationCard } from "@/features/jobs/components/JobLocationCard";
import { JobNotesCard } from "@/features/jobs/components/JobNotesCard";
import { JobPendingActionHint } from "@/features/jobs/components/JobPendingActionHint";
import { JobPhotos } from "@/features/jobs/components/JobPhotos";
import { JobScheduleCard } from "@/features/jobs/components/JobScheduleCard";
import { JobServiceDetailsCard } from "@/features/jobs/components/JobServiceDetailsCard";
import { JobStatusOverview } from "@/features/jobs/components/JobStatusOverview";
import { JobTimelineCard } from "@/features/jobs/components/JobTimelineCard";
import { OccurrenceOriginLink } from "@/features/jobs/components/OccurrenceOriginLink";
import { getJobById } from "@/services/jobs/jobs.service";
import {
  canCompleteOwnAssignment,
  canStartOwnAssignment,
  hasCompletedOwnAssignment,
  isAssignedTo,
  isPrimaryAssignee,
} from "@/utils/jobAssignees";
import { getStartBlockMessage } from "@/utils/jobSchedule";
import { confirmCompleteJob, confirmCompleteWhilePaused } from "@/utils/jobDialogs";
import type { Job } from "@/types/job";
import type { WorkSummary } from "@/services/offline/workJournal.core";
import { useFocusEffect } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";
import { toUserMessage } from "@/utils/userMessages";
import { markVisibleWorkTiming } from "@/utils/workTiming";
import { useTranslation } from "react-i18next";
import { INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";

// ─────────────────────────────────────────────
// JobDetailScreen
// ─────────────────────────────────────────────
export default function JobDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t, i18n } = useTranslation();
  const localeTag = INTL_LOCALE_TAGS[i18n.language as AppLocale] ?? "de-DE";

  // Offset für KeyboardAvoidingView: oberer Safe-Area-Inset + Header-Höhe,
  // damit das Input-Feld beim Öffnen der Tastatur sichtbar bleibt (kein Overlap).
  const insets = useSafeAreaInsets();
  const keyboardOffset = insets.top + theme.spacing.tapTarget;

  // Ref auf die ScrollView, um beim Fokus des Kommentarfelds ans Ende zu
  // scrollen (Eingabe + Senden über der Tastatur sichtbar halten).
  const scrollRef = useRef<ScrollView>(null);
  const handleCommentFocus = useCallback(() => {
    // Kurzer Timeout, damit die Tastatur zuerst öffnen kann und scrollToEnd
    // die endgültige Content-Höhe trifft (iOS + Android).
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 250);
  }, []);

  const { id } = useLocalSearchParams<{ id: string }>();
  const { role, profile, forceCompleteEnabled, pauseResumeEnabled } = useAuth();
  const {
    jobs,
    startJob,
    completeJob,
    pauseJob,
    resumeJob,
    workOperations,
    workSummaries,
    recordedWorkSummaries,
    refreshAssignmentWork,
    forceCompleteJob,
    loading,
    online,
    pendingActions,
    isSyncing,
    markJobCommentsAsRead,
    refreshJobs,
  } = useJobs();

  // Ziel des Korrektur-Sheets (Phase B1). Nur Admins können es öffnen — die
  // Karte blendet die Aktion sonst gar nicht ein, und die RPC prüft die Rolle
  // zusätzlich serverseitig.
  const [correctionTarget, setCorrectionTarget] =
    useState<TimeCorrectionTarget | null>(null);

  // PHASE 16: Admin-Zwangsabschluss (hängender Auftrag, Abschluss vergessen).
  const [forceCompleteOpen, setForceCompleteOpen] = useState(false);
  const [adminSessionSummaries, setAdminSessionSummaries] = useState<Record<string, WorkSummary>>({});

  // Cache-first: zuerst aus dem (ggf. begrenzten) Context-Fenster.
  const cachedJob = useMemo(() => jobs.find((j) => j.id === id), [jobs, id]);

  // Fallback: liegt der Job NICHT im Cache (z. B. außerhalb des Zeitplan-
  // Fensters oder per Deep-Link direkt geöffnet), direkt per ID nachladen.
  // RLS entscheidet über Sichtbarkeit (fremde Firma → kein Datensatz).
  const [fetchedJob, setFetchedJob] = useState<Job | null>(null);
  const [fetchingJob, setFetchingJob] = useState(false);
  const [fetchAttempted, setFetchAttempted] = useState(false);

  useEffect(() => {
    // Reset, wenn die ID wechselt.
    setFetchedJob(null);
    setFetchAttempted(false);
  }, [id]);

  // Nach einer Zeitkorrektur beide Quellen auffrischen (Phase B1):
  // refreshJobs deckt den Context-Cache ab, das Zurücksetzen von
  // fetchAttempted den Direktabruf-Zweig. Ohne Letzteres bliebe ein per
  // Deep-Link geöffneter Auftrag (nicht im Ladefenster) mit den ALTEN Zeiten
  // stehen, obwohl die Korrektur gespeichert wurde.
  const handleCorrected = useCallback(() => {
    setFetchedJob(null);
    setFetchAttempted(false);
    void refreshJobs();
  }, [refreshJobs]);

  useEffect(() => {
    if (!id || cachedJob || fetchAttempted) return;
    let cancelled = false;
    setFetchingJob(true);
    getJobById(id)
      .then((j) => {
        if (!cancelled) setFetchedJob(j);
      })
      .catch(() => {
        if (!cancelled) setFetchedJob(null);
      })
      .finally(() => {
        if (!cancelled) {
          setFetchingJob(false);
          setFetchAttempted(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, cachedJob, fetchAttempted]);

  const job = cachedJob ?? fetchedJob ?? undefined;
  const ownAssignment = job?.assignees.find((assignee) => assignee.employeeId === profile?.id);
  const ownSummary = ownAssignment ? workSummaries[ownAssignment.assignmentId] : null;
  const ownRecorded = ownAssignment ? recordedWorkSummaries[ownAssignment.assignmentId] : null;
  const workUi = job ? deriveAssignmentWorkUi({ job, role, userId: profile?.id,
    capability: pauseResumeEnabled, summary: ownSummary, operations: workOperations }) : null;
  const workedLabel = useSessionWorkedTime(ownSummary, ownRecorded, workUi?.pending);
  const ownAssignmentId = ownAssignment?.assignmentId;
  useEffect(() => {
    if (ownAssignmentId && ownAssignment?.trackingMode === "sessions" && !ownSummary && online) {
      void refreshAssignmentWork(ownAssignmentId).catch(() => {});
    }
  }, [ownAssignmentId, ownAssignment?.trackingMode, ownSummary, online, refreshAssignmentWork]);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [actionError, setActionError] = useState("");

  // Runs after Job Detail commits a new effective state and action decision.
  useEffect(() => {
    if (!job) return;
    markVisibleWorkTiming({ jobId: job.id, state: workUi?.state ?? "none",
      parent: job.status, pending: workUi?.pending?.action ?? "none",
      start: workUi?.canStart ?? false,
      pause: workUi?.canPause ?? false, resume: workUi?.canResume ?? false,
      complete: workUi?.canComplete ?? false, reason: workUi?.blockReason ?? "none",
      online, submitting, syncing: isSyncing, capability: pauseResumeEnabled, role: role ?? "none",
      summaryMode: ownSummary?.trackingMode ?? "none", ownMode: ownAssignment?.trackingMode ?? "none",
      revision: ownSummary?.workRevision ?? null,
      expectedRevision: workUi?.pending ? workUi.pending.expectedRevision + 1 : null,
      summaryAssignmentMatches: !!workUi?.pending && ownSummary?.assignmentId === workUi.pending.assignmentId,
      sessionMatches: !!workUi?.pending && ownSummary?.activeSessionId ===
        (["start", "resume"].includes(workUi.pending.action) ? workUi.pending.sessionId : null) });
  }, [job?.id, job?.status, workUi?.state, workUi?.pending?.action, workUi?.canPause,
    workUi?.canResume, workUi?.canComplete, workUi?.blockReason, online, submitting,
    pauseResumeEnabled, role, ownSummary, ownAssignment, workUi?.canStart, isSyncing]);

  const isAdmin = role === "admin";
  const jobId = job?.id;
  const hasCachedJob = !!cachedJob;
  // Parent-Regel: job_type='recurring' ohne parentJobId — Vorlage, kein
  // startbarer Termin. Generierte Occurrences sind job_type='single'.
  // Wird unten an RecurringRuleDetailScreen weitergereicht.
  const isParentRule =
    !!job && job.jobType === "recurring" && !job.parentJobId;

  // Darf der Nutzer den Ungelesen-Status dieses Jobs schreiben?
  //
  // Spiegelt BEIDE Zweige des Server-Prädikats, das hier zweimal identisch
  // gilt — in den INSERT/UPDATE-Policies auf job_comment_reads (seit
  // 20260826000001) und in get_unread_comment_job_ids() (seit
  // 20260904000000):
  //     assigned_to = auth.uid()  OR  is_assigned_to_job(job)
  // also `isPrimaryAssignee` ODER `isAssignedTo`, exakt wie es
  // `canRunJobActions` für Start/Abschluss tut.
  //
  // Beide Zweige sind nötig, und zwar aus GEGENSÄTZLICHEN Gründen:
  //  - `isAssignedTo` allein ließe den roten Punkt bei einem Auftrag stehen,
  //    für den nur der Legacy-Zeiger existiert (keine job_assignments-Zeile,
  //    Bestandsdaten): `mapAssignees` liefert dort `[]`, die RPC meldet den
  //    Auftrag aber über ihren Legacy-Zweig als ungelesen.
  //  - `isPrimaryAssignee` allein (der Stand vor 20260904000000) ließe ihn
  //    bei jedem sekundär Zugewiesenen stehen.
  // Genau diese Kopplung — wer gemeldet wird, muss markieren dürfen — ist
  // die bindende Invariante aus dem Kopfkommentar von 20260904000000.
  const canMarkCommentsRead =
    !!job &&
    (isAdmin ||
      isAssignedTo(job, profile?.id) ||
      isPrimaryAssignee(job, profile?.id));

  // Beim Öffnen die Kommentare dieses Jobs als gesehen markieren
  // (entfernt den roten Punkt). Online-only, optimistisch im Context.
  useEffect(() => {
    if (id && canMarkCommentsRead) {
      markJobCommentsAsRead(id);
    }
  }, [id, canMarkCommentsRead, markJobCommentsAsRead]);

  // `app/jobs/[id]/edit` wird ÜBER diesen Screen gepusht, ohne ihn zu
  // unmounten — ein reiner Mount-Effect würde beim Zurücknavigieren nie
  // erneut feuern. Deshalb bei JEDEM Fokussieren prüfen.
  useFocusEffect(
    useCallback(() => {
      // Der Job selbst kommt aus dem Context-Cache ODER aus dem Direktabruf.
      // Nur im zweiten Fall (Parent-Regeln liegen meist außerhalb des
      // Context-Fensters) kann er nach dem Bearbeiten veraltet sein — dann
      // hier neu holen. Im Cache-Fall hält Realtime den Job aktuell.
      // Bewusst `hasCachedJob` (boolean) statt `cachedJob`: das Objekt bekommt
      // bei jedem Context-Update eine neue Identität und würde den Effect
      // unnötig neu auslösen.
      if (jobId && !hasCachedJob) {
        getJobById(jobId)
          .then((fresh) => {
            if (fresh) setFetchedJob(fresh);
          })
          .catch(() => {});
      }
    }, [jobId, hasCachedJob]),
  );

  // ── Loading-Zustand: Context lädt, Direktabruf läuft, oder der Abruf wurde
  // noch nicht versucht (verhindert ein „nicht gefunden"-Aufblitzen).
  if ((loading && !cachedJob) || (!job && (fetchingJob || !fetchAttempted))) {
    return <LoadingScreen />;
  }

  // ── Job nicht gefunden
  if (!job) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <StatusBar
          barStyle={theme.isDark ? "light-content" : "dark-content"}
          backgroundColor={theme.colors.background}
        />
        <JobDetailHeader showMenu={false} menuBusy={false} onMenuPress={() => {}} />
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("jobs:detail.notFoundTitle")}
            message={t("jobs:detail.notFoundMessage")}
            icon="alert-circle-outline"
            ctaLabel={t("common:actions.back")}
            onCta={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ── Parent-Regel: eigene Ansicht, gleiche Route.
  // Muss NACH allen Hooks stehen (Hook-Reihenfolge), aber VOR allem, was
  // sich auf einen ausführbaren Termin bezieht. Das Markieren gelesener
  // Kommentare oben gilt weiterhin für beide Fälle — unverändert.
  if (isParentRule) {
    return (
      <RecurringRuleDetailScreen
        rule={job}
        isAdmin={isAdmin}
        onRuleRefreshed={setFetchedJob}
      />
    );
  }

  // ── Aktionen (nutzen weiter JobContext → Offline-Sync bleibt intakt)
  const handleStart = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setActionError("");
    try {
      setSubmitting(true);
      await startJob(job.id);
    } catch (err: unknown) {
      setActionError(
        toUserMessage(err, t("jobs:errors.startFailed"))
      );
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const handlePause = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setActionError("");
    try { await pauseJob(job.id); }
    catch (err) { setActionError(toUserMessage(err, t("jobs:work.actionFailed"))); }
    finally { setSubmitting(false); submittingRef.current = false; }
  };

  const handleResume = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setActionError("");
    try { await resumeJob(job.id); }
    catch (err) { setActionError(toUserMessage(err, t("jobs:work.actionFailed"))); }
    finally { setSubmitting(false); submittingRef.current = false; }
  };

  const handleComplete = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setActionError("");

    // Abschließen ist unumkehrbar (setzt completed_at) — vorher nachfragen.
    // Start bleibt bewusst ohne Rückfrage.
    const bestaetigt = await (workUi?.mode === "sessions" && workUi.state === "paused"
      ? confirmCompleteWhilePaused() : confirmCompleteJob());
    if (!bestaetigt) {
      submittingRef.current = false;
      return;
    }

    try {
      setSubmitting(true);
      await completeJob(job.id);
    } catch (err: unknown) {
      setActionError(
        toUserMessage(err, t("jobs:errors.completeFailed"))
      );
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const handleEdit = () => {
    router.push(`/jobs/${job.id}/edit`);
  };

  // Der Dialog zeigt Fehler selbst an — hier bewusst KEIN try/catch, damit eine
  // serverseitige Ablehnung (z. B. „erst nicht teilnehmende Mitarbeiter
  // entfernen") im Dialog sichtbar bleibt statt ihn zu schließen.
  const handleForceComplete = async (reason: string) => {
    await forceCompleteJob(job.id, reason);
  };

  // ── Maps öffnen (plattform-spezifischer URL-Schema)
  const handleOpenInMaps = () => {
    setActionError("");
    if (!job.location?.trim()) {
      setActionError(t("jobs:detail.noAddress"));
      return;
    }
    const query = encodeURIComponent(job.location.trim());
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${query}`,
      android: `https://www.google.com/maps/search/?api=1&query=${query}`,
      default: `https://www.google.com/maps/search/?api=1&query=${query}`,
    });
    Linking.openURL(url!).catch(() => {
      setActionError(t("jobs:detail.mapsFailed"));
    });
  };

  // BERECHTIGUNG Start/Abschluss (Phase 7, „Shared Job Time"): JEDER
  // Zugewiesene darf, nicht nur der Legacy-Primär (Rolle, job_type,
  // Zuweisungsmenge ODER Legacy-Zeiger, Firma). canStartOwnAssignment/
  // canCompleteOwnAssignment (Phase 16) rufen canRunJobActions selbst auf —
  // kein eigenständiges canRunActions mehr nötig.

  // PHASE 16 — START ist nicht mehr an job.status==='open' gebunden: ist der
  // Auftrag bereits durch eine Kollegin gestartet, darf DIESER Nutzer seine
  // EIGENE Teilnahme trotzdem noch beginnen (Nachzügler-Zweig von
  // start_own_job) — ohne das gäbe es für einen später hinzugekommenen
  // Mitarbeiter NIE einen Weg, den eigenen Start zu setzen, und er könnte
  // seine Teilnahme folglich nie abschließen (canCompleteOwnAssignment
  // verlangt genau diesen eigenen Start). canStartOwnAssignment kapselt
  // beide Zweige — siehe dortigen Kommentar.
  //
  // Termin (Nachtzuschlag für Spätdienste ab 20:00 bis 02:00 des Folgetags)
  // bleibt ein separater Schritt: maßgeblich ist der Server, die Prüfung hier
  // verhindert nur einen Button, der garantiert abgelehnt würde, und liefert
  // eine Meldung, die den Termin nennt.
  const eligibleToStart = canStartOwnAssignment(job, role, profile?.id);
  const startBlockedReason = eligibleToStart
    ? getStartBlockMessage(job, t, localeTag)
    : null;
  const canStart = (workUi?.mode === "sessions" ? workUi.canStart : eligibleToStart) && !startBlockedReason;

  // PHASE 16 — ABSCHLUSS nur der EIGENEN Teilnahme und nur nach EIGENEM Start.
  // Der Start eines Kollegen berechtigt ausdrücklich nicht (Vorfall
  // 2026-09-16). canCompleteOwnAssignment prüft bereits vollständig (eigener
  // Start gesetzt, Auftrag noch in_progress, eigener Teil noch nicht
  // abgeschlossen) — kein zusätzlicher Check hier nötig.
  const ownCompleted = hasCompletedOwnAssignment(job, profile?.id);
  const canComplete = workUi?.mode === "sessions" ? workUi.canComplete : canCompleteOwnAssignment(job, role, profile?.id);

  // „Mein Teil ist fertig, der Auftrag läuft weiter" (Phase 16).
  const waitingOnOthers = ownCompleted && job.status === "in_progress";

  const isDone = job.status === "completed";

  // PHASE 16 — Admin-Wiederherstellung: nur bei laufendem Auftrag anbieten, und
  // nur wenn tatsächlich jemand gestartet, aber nicht abgeschlossen hat (genau
  // der Fall, den die RPC annimmt). Nie gestartete Zuweisungen lehnt der Server
  // ab — die gehören regulär aus der Zuweisung entfernt.
  // force_complete_enabled (app_config, Migration 20260916120000): bleibt
  // false, bis der Phase-16-Backend-Support bestätigt live ist — der neue
  // Client könnte sonst vor dem Backend ausgeliefert werden und einen
  // Button zeigen, dessen RPC (admin_force_complete_job) noch gar nicht
  // existiert. Fail CLOSED, siehe AuthContext.tsx.
  const showForceComplete =
    isAdmin &&
    forceCompleteEnabled &&
    job.status === "in_progress" &&
    (job.assignees ?? []).some(
      (a) => !!a.employeeStartedAt && !a.employeeCompletedAt,
    );

  // Foto-Upload: Admin immer; Employee, wenn ihm der Auftrag zugewiesen ist
  // (volle Zuweisungsmenge, nicht nur der Legacy-Primär). Seit 20260826000001
  // erlauben die Insert-Policies auf job_photos und storage.objects genau
  // das — spiegelt exakt das Server-Prädikat, wie canRunJobActions es für
  // Start/Abschluss tut.
  // isOnline wird separat übergeben — JobPhotos zeigt den Offline-Hinweis selbst.
  const canUploadPhotos =
    role === "admin" ||
    (role === "employee" && isAssignedTo(job, profile?.id));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />

      {/* Das Aktionsmenü im Header gehört ausschließlich zu Parent-Regeln —
          für ausführbare Termine gab es hier noch nie einen Menüpunkt. */}
      <JobDetailHeader showMenu={false} menuBusy={false} onMenuPress={() => {}} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={keyboardOffset}
      >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 1 — Hero: Kunde/Objekt, Status, Service, Termin */}
        <JobStatusOverview job={job} />

        {/* 1b — Herkunft: EIN antippbarer Weg zurück zur Regel. Ersetzt die
            beiden bisherigen, nicht antippbaren Hinweise (Kopfzeile +
            Terminierungs-Karte), die dasselbe zweimal sagten.

            NUR FÜR ADMINS. Die Lese-Policy „employee read own assigned jobs"
            auf public.jobs verlangt job_type = 'single'; eine Parent-Regel ist
            job_type = 'recurring' und für Mitarbeitende damit grundsätzlich
            nicht lesbar. Ein Link dorthin endete für sie ausnahmslos in
            „Job nicht gefunden" — also gar nicht erst anbieten. Mitarbeitende
            bekommen dadurch keine Information weniger als vor diesem PR: sie
            konnten die Regel noch nie öffnen. */}
        {isAdmin && job.parentJobId ? (
          <OccurrenceOriginLink parentJobId={job.parentJobId} />
        ) : null}

        {/* Globaler Speicher-/Verbindungsstatus + Aktions-Fehler bleiben
            oben — Chrome, kein Inhalt, muss ohne Scrollen sichtbar sein. */}
        <OfflineBanner />
        {!isAdmin ? <WorkReconciliationNotice jobId={job.id} /> : null}
        {actionError ? (
          <ErrorBanner
            message={actionError}
            onDismiss={() => setActionError("")}
          />
        ) : null}

        {/* 2 — Adresse + Maps */}
        <JobLocationCard
          location={job.location}
          onOpenInMaps={handleOpenInMaps}
        />

        {/* 3 — Zugewiesene Mitarbeitende */}
        <AssignedEmployeesCard
          job={job}
          isAdmin={isAdmin}
          onSessionSummariesChange={setAdminSessionSummaries}
          onCorrectTime={(assignee) =>
            setCorrectionTarget({
              assignmentId: assignee.assignmentId,
              employeeName: assignee.fullName,
              customerName: job.customerName,
              remark: job.service,
              employeeStartedAt: assignee.employeeStartedAt,
              employeeCompletedAt: assignee.employeeCompletedAt,
              // Vorschlag aus der GETEILTEN Auftragszeit — im Sheet
              // ausdrücklich als solcher beschriftet, nie als Arbeitszeit.
              sharedStartedAt: job.startedAt,
              sharedCompletedAt: job.completedAt,
            })
          }
        />

        {workUi?.mode === "sessions" ? (
          <SessionWorkStatus state={workUi.state} workedLabel={workedLabel}
            pendingAction={workUi.pending?.action} reviewRequired={workUi.reviewRequired}
            reviewed={ownSummary?.reviewed ?? false}
            latestSessionEnd={workUi.pending?.action === "pause"
              ? workUi.pending.actionTimestamp : ownRecorded?.latestSessionEnd} />
        ) : null}

        {/* 4 — Zeitlicher Verlauf (Start/Ende/Akteure/Dauer bzw. geplant) */}
        <JobTimelineCard job={job} showPlaceholder isAdmin={isAdmin} />

        {/* 5 — Service + Terminierung */}
        <JobServiceDetailsCard service={job.service} />
        <JobScheduleCard job={job} />

        {/* 6 — Notizen */}
        {job.notes ? <JobNotesCard notes={job.notes} /> : null}

        {/* 7 — Fotos (Upload + Anzeige, online-only, unverändert) */}
        <JobPhotos
          jobId={job.id}
          canUpload={canUploadPhotos}
          isOnline={online}
        />

        {/* 8 — Kommentare (append-only, online-only, unverändert) */}
        <JobComments
          jobId={job.id}
          canComment={isAdmin || isAssignedTo(job, profile?.id)}
          onInputFocus={handleCommentFocus}
        />

        {/* 9 — Job-spezifischer Offline-Hinweis, direkt vor den Aktionen,
            auf die er sich bezieht (die Aktionsleiste liegt unmittelbar
            darunter, jetzt fixiert am unteren Rand) */}
        <JobPendingActionHint jobId={job.id} pendingActions={pendingActions} />
      </ScrollView>

      {/* 10 — Aktionen: FIXIERT, außerhalb des Scroll-Flusses.
          Als Geschwister der ScrollView innerhalb der KeyboardAvoidingView —
          dadurch rutscht die Leiste bei geöffneter Tastatur mit nach oben und
          liegt nie unter ihr. Der Scroll-Bereich wird entsprechend kürzer, die
          Leiste überdeckt also auch keine Kommentare. */}
      <JobActionFooter
        jobId={job.id}
        canStart={canStart}
        canComplete={canComplete}
        canPause={workUi?.canPause ?? false}
        canResume={workUi?.canResume ?? false}
        onPause={handlePause}
        onResume={handleResume}
        pendingAction={workUi?.pending?.action}
        isDone={isDone}
        submitting={submitting}
        onStart={handleStart}
        onComplete={handleComplete}
        showEdit={isAdmin}
        onEdit={handleEdit}
        waitingOnOthers={waitingOnOthers}
        startBlockedReason={startBlockedReason}
        showForceComplete={showForceComplete}
        onForceComplete={() => setForceCompleteOpen(true)}
      />
      </KeyboardAvoidingView>

      <ForceCompleteSheet
        visible={forceCompleteOpen}
        customerName={job.customerName}
        onClose={() => setForceCompleteOpen(false)}
        onConfirm={handleForceComplete}
        activeSessionBlocked={hasActiveAssignmentSession(adminSessionSummaries, job)}
        sessionStateLoading={job.assignees.some((assignee) => assignee.trackingMode === "sessions" &&
          !adminSessionSummaries[assignee.assignmentId])}
      />

      <TimeCorrectionSheet
        visible={!!correctionTarget}
        target={correctionTarget}
        onClose={() => setCorrectionTarget(null)}
        onCorrected={handleCorrected}
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

    // Wrapper für KeyboardAvoidingView (füllt Platz unter dem Header)
    flex: {
      flex: 1,
    },

    // Empty-Variante
    emptyWrap: {
      flex: 1,
    },

    // Scroll-Container
    scroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingTop: theme.spacing.lg,
      paddingBottom: 32,
      gap: theme.spacing.md,
    },
  });
}
