// features/jobs/JobDetailScreen.tsx
// Detail-Ansicht eines Jobs mit allen Infos und kontextabhängigen Aktionen.
// Aktionen (Start/Complete/Edit) nutzen weiter den bestehenden JobContext —
// keine Änderungen an Supabase-/Offline-Sync-Logik.

import {
  ActionMenuSheet,
  AppHeader,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  InfoRow,
  LoadingScreen,
  OfflineBanner,
  StatusBadge,
  type ActionMenuItem,
} from "@/components/ui";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { JobComments } from "@/features/jobs/components/JobComments";
import { JobPhotos } from "@/features/jobs/components/JobPhotos";
import { RuleOccurrences } from "@/features/jobs/components/RuleOccurrences";
import {
  getJobById,
  getJobOccurrences,
  setRecurringRuleActive,
} from "@/services/jobs/jobs.service";
import { WorkedTimeCard } from "@/features/jobs/components/WorkedTimeCard";
import { formatRecurringDays } from "@/utils/recurrence";
import {
  canRunJobActions,
  formatAssigneesFull,
  getAssignees,
  isPrimaryAssignee,
  UNASSIGNED_LABEL,
} from "@/utils/jobAssignees";
import type { Job } from "@/types/job";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { AppTheme } from "@/constants/theme";

// ─────────────────────────────────────────────
// Datums-/Zeit-Formatierung
// ─────────────────────────────────────────────
function formatDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const datePart = date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${datePart} um ${timePart}`;
}

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
        <AppHeader title="Job-Details" showBack />
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

  // ── Formatierte Werte
  const isRecurring = job.jobType === "recurring";
  const recurringDaysText = formatRecurringDays(job.recurringDays);
  const timeText = job.startTime ? `${job.startTime} Uhr` : "—";
  const scheduledStartText =
    formatDateTime(job.scheduledStart) ?? "Kein Termin geplant";
  // ANZEIGE: vollständige Zuweisungsmenge (Phase 5). Gelöschte Konten
  // erscheinen mit „(ehemalig)", damit der Nachweis lesbar bleibt.
  const assignees = getAssignees(job);
  const employeeText =
    assignees.length > 0 ? formatAssigneesFull(job) : UNASSIGNED_LABEL;
  const employeeLabel = assignees.length > 1 ? "Mitarbeitende" : "Mitarbeiter";

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

      {/* ── Sticky-Header ── */}
      {/* Header-Rechts: Aktions-Menü der Regel (früher: inertes „Admin"-Badge,
          das nur die ohnehin bekannte Rolle wiederholte). */}
      <AppHeader
        title="Job-Details"
        showBack
        right={
          isAdmin && isParentRule ? (
            <TouchableOpacity
              style={styles.headerMenuBtn}
              onPress={() => setMenuOpen(true)}
              disabled={ruleBusy}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Aktionen für diesen Dauerauftrag"
              accessibilityHint="Öffnet Bearbeiten, Aktivieren/Deaktivieren und Löschen"
            >
              {ruleBusy ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <Ionicons
                  name="ellipsis-horizontal"
                  size={20}
                  color={theme.colors.onSurface}
                />
              )}
            </TouchableOpacity>
          ) : undefined
        }
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
        {/* ── Hero: Kunden-Name + Status ──
            Bei Parent-Regeln ist der Job-Status bedeutungslos (er gilt global
            für die Regel, nicht für einen konkreten Tag) — dort zählt
            ausschließlich Aktiv/Inaktiv. Deshalb genau EIN Badge, und die
            frühere Zeile „Status: Aktiv" in der Detail-Karte entfällt. */}
        <View style={styles.hero}>
          <Text style={styles.customerName}>{job.customerName}</Text>
          {isParentRule ? (
            <Badge
              label={job.isActive ? "Aktiv" : "Inaktiv"}
              variant={job.isActive ? "success" : "default"}
            />
          ) : (
            <StatusBadge status={job.status} />
          )}
        </View>

        {/* Kompakter Typ-Hinweis statt des früheren großen blauen
            Erklär-Banners (ganzer Absatz „Dies ist eine Vorlage …"). */}
        {isParentRule ? (
          <View style={styles.ruleTypeRow}>
            <Ionicons
              name="repeat-outline"
              size={14}
              color={theme.colors.primary}
            />
            <Text style={styles.ruleTypeText}>Wiederkehrender Auftrag</Text>
          </View>
        ) : null}

        {/* ── Save-Status ── */}
        <OfflineBanner />

        {/* ── Fehler-Banner (Aktionen) ── */}
        {actionError ? (
          <ErrorBanner
            message={actionError}
            onDismiss={() => setActionError("")}
          />
        ) : null}

        {/* ── Arbeitszeit — prominent, direkt nach dem Hero ── */}
        <WorkedTimeCard job={job} />

        {/* ── Details-Karte ── */}
        <Card padding={theme.spacing.lg} style={styles.card}>
          <InfoRow label="Service" value={job.service} icon="construct-outline" />
          <View style={styles.rowDivider} />

          <InfoRow
            label="Adresse"
            value={job.location || "—"}
            icon="location-outline"
          />
          {job.location ? (
            <View style={styles.mapsBtnRow}>
              <Button
                label="In Maps öffnen"
                variant="secondary"
                icon="map-outline"
                fullWidth={false}
                onPress={handleOpenInMaps}
                style={{ paddingHorizontal: theme.spacing.lg }}
              />
            </View>
          ) : null}
          <View style={styles.rowDivider} />

          {isRecurring ? (
            // Auftragstyp-Zeile entfällt: der Typ steht bereits als kompakter
            // Hinweis unter dem Titel. Hier nur noch entscheidungsrelevante
            // Terminierung.
            <>
              <InfoRow
                label="Wochentage"
                value={recurringDaysText}
                icon="calendar-number-outline"
              />
              <View style={styles.rowDivider} />
              <InfoRow label="Uhrzeit" value={timeText} icon="time-outline" />
              <View style={styles.rowDivider} />
            </>
          ) : (
            <>
              <InfoRow
                label="Auftragstyp"
                value="Einmalig"
                icon="calendar-outline"
              />
              <View style={styles.rowDivider} />
              <InfoRow
                label="Geplanter Start"
                value={scheduledStartText}
                icon="calendar-outline"
              />
              <View style={styles.rowDivider} />
            </>
          )}

          <InfoRow
            label={employeeLabel}
            value={employeeText}
            icon={assignees.length > 1 ? "people-outline" : "person-outline"}
            // Mehrfachzuweisungen dürfen nicht abgeschnitten werden — der
            // Detail-Screen ist die Stelle, an der die Menge vollständig
            // nachvollziehbar sein muss.
            valueNumberOfLines={6}
          />
        </Card>

        {/* ── Notizen ── */}
        {job.notes ? (
          <Card padding={theme.spacing.lg} style={styles.card}>
            <View style={styles.notesLabelRow}>
              <Ionicons
                name="document-text-outline"
                size={12}
                color={theme.colors.primary}
              />
              <Text style={styles.notesLabel}>NOTIZEN</Text>
            </View>
            <Text style={styles.notesText}>{job.notes}</Text>
          </Card>
        ) : null}

        {/* ── Generierte Termine (nur für Admin bei Parent-Recurring-Jobs) ── */}
        {isParentRule && isAdmin ? (
          <RuleOccurrences
            occurrences={occurrences}
            loading={occurrencesLoading}
            onOpen={(occ) => router.push(`/jobs/${occ.id}`)}
          />
        ) : null}

        {/* ── Fotos (Upload + Anzeige, online-only) ── */}
        <JobPhotos
          jobId={job.id}
          canUpload={canUploadPhotos}
          isOnline={online}
        />

        {/* ── Kommentare (append-only, online-only) ── */}
        {/* Schreibrecht = Legacy-Primär oder Admin (RLS-Insert-Policy).
            Sekundär Zugewiesene lesen mit, sehen aber kein Eingabefeld. */}
        <JobComments
          jobId={job.id}
          canComment={isAdmin || isPrimaryAssignee(job, profile?.id)}
          onInputFocus={handleCommentFocus}
        />

        {/* ── Aktionen ── */}
        <View style={styles.actions}>
          {canStart ? (
            <Button
              label="Job starten"
              icon="play"
              loading={submitting}
              disabled={submitting}
              onPress={handleStart}
            />
          ) : null}

          {canComplete ? (
            <Button
              label="Job abschließen"
              icon="checkmark"
              loading={submitting}
              disabled={submitting}
              onPress={handleComplete}
            />
          ) : null}

          {isDone ? (
            <View style={styles.doneInfo}>
              <Ionicons
                name="checkmark-circle"
                size={20}
                color={theme.colors.statusCompleted}
              />
              <Text style={styles.doneInfoText}>
                Dieser Job ist abgeschlossen.
              </Text>
            </View>
          ) : null}

          {/* Bei Parent-Regeln liegt „Bearbeiten" im Header-Menü — kein
              zweiter Button für dieselbe Aktion. */}
          {isAdmin && !isParentRule ? (
            <Button
              label="Bearbeiten"
              variant="secondary"
              icon="create-outline"
              disabled={submitting}
              onPress={handleEdit}
            />
          ) : null}
        </View>

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

    // Header rechts: Aktions-Menü — sichtbarer runder Hintergrund, damit der
    // Button als Bedienelement lesbar ist und nicht wie ein Meta-Icon wirkt.
    headerMenuBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.surfaceContainerHigh,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
    },

    // Hero-Bereich
    hero: {
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    customerName: {
      fontSize: theme.typography.size.xxl,
      fontFamily: theme.typography.family.bold,
      fontWeight: theme.typography.weight.bold,
      color: theme.colors.onSurface,
      letterSpacing: theme.typography.letterSpacing.tight,
      lineHeight: theme.typography.lineHeight.xxl,
    },

    // Cards
    card: {
      gap: theme.spacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: theme.colors.outlineVariant,
    },
    mapsBtnRow: {
      flexDirection: "row",
      marginTop: 4,
    },

    // Notizen
    notesLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 6,
    },
    notesLabel: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    notesText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Aktionen
    actions: {
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    doneInfo: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      minHeight: theme.spacing.tapTarget,
    },
    doneInfoText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusCompleted,
    },

    // Kompakter Typ-Hinweis (ersetzt das große Erklär-Banner)
    ruleTypeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: -theme.spacing.xs,
    },
    ruleTypeText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
  });
}
