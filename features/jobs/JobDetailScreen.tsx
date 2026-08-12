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
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import RecurringRuleDetailScreen from "@/features/jobs/RecurringRuleDetailScreen";
import { AssignedEmployeesCard } from "@/features/jobs/components/AssignedEmployeesCard";
import {
  TimeCorrectionSheet,
  type TimeCorrectionTarget,
} from "@/features/timesheets/components/TimeCorrectionSheet";
import { JobActionFooter } from "@/features/jobs/components/JobActionFooter";
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
import { canRunJobActions, isPrimaryAssignee } from "@/utils/jobAssignees";
import { confirmCompleteJob } from "@/utils/jobDialogs";
import type { Job } from "@/types/job";
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

// ─────────────────────────────────────────────
// JobDetailScreen
// ─────────────────────────────────────────────
export default function JobDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

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
  const { role, profile } = useAuth();
  const {
    jobs,
    startJob,
    completeJob,
    loading,
    online,
    pendingActions,
    markJobCommentsAsRead,
    refreshJobs,
  } = useJobs();

  // Ziel des Korrektur-Sheets (Phase B1). Nur Admins können es öffnen — die
  // Karte blendet die Aktion sonst gar nicht ein, und die RPC prüft die Rolle
  // zusätzlich serverseitig.
  const [correctionTarget, setCorrectionTarget] =
    useState<TimeCorrectionTarget | null>(null);

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

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");

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
  // job_comment_reads hat eigene INSERT/UPDATE-Policies, die weiterhin den
  // LEGACY-PRIMÄR verlangen. Ein sekundär Zugewiesener darf die Kommentare
  // zwar lesen (Phase 5), das Markieren schlägt für ihn aber mit 42501 fehl.
  // Der Fehler würde im JobContext stillschweigend geschluckt — also gar
  // nicht erst versuchen.
  // Phase 7 hat NUR start_own_job/complete_own_job erweitert; die
  // Kommentar-/Foto-Schreibpfade folgen in einem eigenen PR.
  const canMarkCommentsRead =
    !!job && (isAdmin || isPrimaryAssignee(job, profile?.id));

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
            title="Job nicht gefunden"
            message="Der gesuchte Job ist nicht (mehr) verfügbar."
            icon="alert-circle-outline"
            ctaLabel="Zurück"
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
    setActionError("");
    try {
      setSubmitting(true);
      await startJob(job.id);
    } catch (err: unknown) {
      setActionError(
        toUserMessage(err, "Job konnte nicht gestartet werden.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async () => {
    setActionError("");

    // Abschließen ist unumkehrbar (setzt completed_at) — vorher nachfragen.
    // Start bleibt bewusst ohne Rückfrage.
    const bestaetigt = await confirmCompleteJob();
    if (!bestaetigt) {
      return;
    }

    try {
      setSubmitting(true);
      await completeJob(job.id);
    } catch (err: unknown) {
      setActionError(
        toUserMessage(err, "Job konnte nicht abgeschlossen werden.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = () => {
    router.push(`/jobs/${job.id}/edit`);
  };

  // ── Maps öffnen (plattform-spezifischer URL-Schema)
  const handleOpenInMaps = () => {
    setActionError("");
    if (!job.location?.trim()) {
      setActionError("Keine Adresse zum Öffnen vorhanden.");
      return;
    }
    const query = encodeURIComponent(job.location.trim());
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${query}`,
      android: `https://www.google.com/maps/search/?api=1&query=${query}`,
      default: `https://www.google.com/maps/search/?api=1&query=${query}`,
    });
    Linking.openURL(url!).catch(() => {
      setActionError("Maps-App konnte nicht geöffnet werden.");
    });
  };

  // BERECHTIGUNG Start/Abschluss (Phase 7, „Shared Job Time"): JEDER
  // Zugewiesene darf, nicht nur der Legacy-Primär — canRunJobActions spiegelt
  // exakt das Prädikat von start_own_job/complete_own_job (Rolle, job_type,
  // Zuweisungsmenge ODER Legacy-Zeiger). Parent-Regeln sind hier nicht mehr
  // möglich (eigener Screen weiter oben) und `canRunJobActions` prüft
  // jobType='single' ohnehin selbst.
  const canRunActions = canRunJobActions(job, role, profile?.id);
  const canStart = canRunActions && job.status === "open";
  const canComplete = canRunActions && job.status === "in_progress";
  const isDone = job.status === "completed";

  // Foto-Upload: Admin immer; Employee nur wenn PRIMÄR zugewiesen.
  // BEWUSSTE ASYMMETRIE zu canStart/canComplete oben: die Insert-Policies auf
  // job_photos und storage.objects hängen weiterhin an assigned_to = auth.uid().
  // Phase 7 hat NUR die beiden Status-RPCs erweitert — Fotos und Kommentare
  // gehören nicht zur Job-Uhr und folgen in einem eigenen PR.
  // isOnline wird separat übergeben — JobPhotos zeigt den Offline-Hinweis selbst.
  const canUploadPhotos =
    role === "admin" ||
    (role === "employee" && isPrimaryAssignee(job, profile?.id));

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
          canComment={isAdmin || isPrimaryAssignee(job, profile?.id)}
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
        canStart={canStart}
        canComplete={canComplete}
        isDone={isDone}
        submitting={submitting}
        onStart={handleStart}
        onComplete={handleComplete}
        showEdit={isAdmin}
        onEdit={handleEdit}
      />
      </KeyboardAvoidingView>

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
