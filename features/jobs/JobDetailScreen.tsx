// features/jobs/JobDetailScreen.tsx
// Detail-Ansicht eines Jobs mit allen Infos und kontextabhängigen Aktionen.
// Aktionen (Start/Complete/Edit) nutzen weiter den bestehenden JobContext —
// keine Änderungen an Supabase-/Offline-Sync-Logik.
//
// "Job Details 2.0": die Präsentationsschicht ist auf kleine, reine
// Anzeige-Komponenten in features/jobs/components/ aufgeteilt (siehe unten).
// Dieser Screen bleibt der Orchestrator: er hält Daten/State/Handler und
// entscheidet NUR, WELCHE Komponente wann sichtbar ist — die Berechtigungs-
// und Aktions-Logik selbst ist unverändert gegenüber der Vorversion.

import {
  ActionMenuSheet,
  EmptyState,
  ErrorBanner,
  LoadingScreen,
  OfflineBanner,
  type ActionMenuItem,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { AssignedEmployeesCard } from "@/features/jobs/components/AssignedEmployeesCard";
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
import { RuleOccurrences } from "@/features/jobs/components/RuleOccurrences";
import {
  getJobById,
  getJobOccurrences,
  setRecurringRuleActive,
} from "@/services/jobs/jobs.service";
import { canRunJobActions, isPrimaryAssignee } from "@/utils/jobAssignees";
import type { Job } from "@/types/job";
import { useFocusEffect } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
    deleteJob,
    loading,
    online,
    pendingActions,
    markJobCommentsAsRead,
  } = useJobs();

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

  // Occurrences für Parent-Recurring-Regeln (nur Admin-Ansicht)
  const [occurrences, setOccurrences] = useState<Job[]>([]);
  const [occurrencesLoading, setOccurrencesLoading] = useState(false);

  // Aktions-Menü im Header (Regel bearbeiten/de-aktivieren/löschen)
  const [menuOpen, setMenuOpen] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);

  const isAdmin = role === "admin";
  const jobId = job?.id;
  const hasCachedJob = !!cachedJob;
  // Parent-Regel: job_type='recurring' ohne parentJobId — Vorlage, kein
  // startbarer Termin. Generierte Occurrences sind job_type='single'.
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

  const loadOccurrences = useCallback(async () => {
    if (!jobId || !isAdmin || !isParentRule) return;
    setOccurrencesLoading(true);
    try {
      setOccurrences(await getJobOccurrences(jobId));
    } catch {
      setOccurrences([]);
    } finally {
      setOccurrencesLoading(false);
    }
  }, [jobId, isAdmin, isParentRule]);

  // Occurrences bei jedem Fokussieren laden statt nur beim Mounten:
  // `app/jobs/[id]/edit` wird ÜBER diesen Screen gepusht, ohne ihn zu
  // unmounten — nach einer Regeländerung (andere Wochentage/Uhrzeit) wären
  // die Termine sonst dauerhaft veraltet. Beim ersten Fokus ist das der
  // initiale Ladevorgang.
  useFocusEffect(
    useCallback(() => {
      loadOccurrences();
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
    }, [loadOccurrences, jobId, hasCachedJob]),
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

  // ── Aktionen (nutzen weiter JobContext → Offline-Sync bleibt intakt)
  const handleStart = async () => {
    setActionError("");
    try {
      setSubmitting(true);
      await startJob(job.id);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Job konnte nicht gestartet werden."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async () => {
    setActionError("");
    try {
      setSubmitting(true);
      await completeJob(job.id);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error
          ? err.message
          : "Job konnte nicht abgeschlossen werden."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = () => {
    router.push(`/jobs/${job.id}/edit`);
  };

  // ── Regel-Aktionen aus dem Header-Menü (nur Parent-Regeln, nur Admin)
  const handleToggleRuleActive = async () => {
    setActionError("");
    setRuleBusy(true);
    try {
      await setRecurringRuleActive(job.id, !(job.isActive ?? true));
      // Regel + Termine neu laden: das Deaktivieren entfernt serverseitig
      // zukünftige offene Termine.
      const fresh = await getJobById(job.id);
      if (fresh) setFetchedJob(fresh);
      await loadOccurrences();
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Aktion fehlgeschlagen.",
      );
    } finally {
      setRuleBusy(false);
    }
  };

  const handleDeleteRule = () => {
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
              await deleteJob(job.id);
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
  };

  // Aktion erst nach dem Schließen des Sheets auslösen — ein Alert oder
  // Navigations-Push während der Modal-Animation wird auf iOS verschluckt.
  const handleMenuSelect = (key: string) => {
    setMenuOpen(false);
    setTimeout(() => {
      if (key === "edit") handleEdit();
      else if (key === "toggle") handleToggleRuleActive();
      else if (key === "delete") handleDeleteRule();
    }, 250);
  };

  const ruleActive = job.isActive ?? true;
  const menuItems: ActionMenuItem[] = [
    { key: "edit", label: "Bearbeiten", icon: "create-outline" },
    {
      key: "toggle",
      label: ruleActive ? "Deaktivieren" : "Aktivieren",
      icon: ruleActive ? "pause-outline" : "play-outline",
    },
    { key: "delete", label: "Löschen", icon: "trash-outline", destructive: true },
  ];

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
  // Zuweisungsmenge ODER Legacy-Zeiger). Der isParentRule-Zusatz ist
  // redundant, bleibt aber als lokale, sichtbare Absicherung stehen: eine
  // Parent-Regel ist kein ausführbarer Termin.
  const canRunActions = canRunJobActions(job, role, profile?.id);
  const canStart = !isParentRule && canRunActions && job.status === "open";
  const canComplete =
    !isParentRule && canRunActions && job.status === "in_progress";
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

      <JobDetailHeader
        showMenu={isAdmin && isParentRule}
        menuBusy={ruleBusy}
        onMenuPress={() => setMenuOpen(true)}
      />

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
        <JobStatusOverview job={job} isParentRule={isParentRule} />

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
        <AssignedEmployeesCard job={job} />

        {/* 4 — Zeitlicher Verlauf (Start/Ende/Akteure/Dauer bzw. geplant).
            Bewusst NICHT an isParentRule gehängt: eine bereits gestartete
            Regel ist eine Anomalie, die sichtbar bleiben muss. Nur der
            Platzhalter vor dem Start gilt für ausführbare Termine. */}
        <JobTimelineCard job={job} showPlaceholder={!isParentRule} />

        {/* 5 — Service + Terminierung/Wiederholung */}
        <JobServiceDetailsCard service={job.service} />
        <JobScheduleCard job={job} isParentRule={isParentRule} />

        {/* 6 — Notizen */}
        {job.notes ? <JobNotesCard notes={job.notes} /> : null}

        {/* Generierte Termine (nur Admin bei Parent-Recurring-Jobs) */}
        {isParentRule && isAdmin ? (
          <RuleOccurrences
            occurrences={occurrences}
            loading={occurrencesLoading}
            onOpen={(occ) => router.push(`/jobs/${occ.id}`)}
          />
        ) : null}

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
            auf die er sich bezieht */}
        <JobPendingActionHint jobId={job.id} pendingActions={pendingActions} />

        {/* 10 — Aktionen */}
        <JobActionFooter
          canStart={canStart}
          canComplete={canComplete}
          isDone={isDone}
          submitting={submitting}
          onStart={handleStart}
          onComplete={handleComplete}
          showEdit={isAdmin && !isParentRule}
          onEdit={handleEdit}
        />

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
      </KeyboardAvoidingView>

      <ActionMenuSheet
        visible={menuOpen}
        title={job.customerName}
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
