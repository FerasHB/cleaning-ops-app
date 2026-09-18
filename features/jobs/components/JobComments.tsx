// features/jobs/components/JobComments.tsx
// Kommentar-Sektion für einen Job (append-only, MVP).
// Liste (Autor, Zeit, Text) + Eingabe. Online-only — nutzt useJobComments
// (kein JobContext, keine Offline-Queue).
//
// SCHREIBRECHT ist NICHT dasselbe wie Leserecht: die RLS-Policy
// "employee insert comments on own jobs" verlangt die volle Zuweisungsmenge
// (assigned_to ODER job_assignments, seit Migration 20260826000001) — ein
// nicht zugewiesener Mitarbeiter darf den Auftrag also gar nicht erst sehen,
// geschweige denn kommentieren. Deshalb MUSS der Aufrufer `canComment`
// dennoch setzen; ohne dieses Prop hätte z. B. ein Admin, der gerade keinen
// Zugriff mehr hat, ein aktives Senden-Feld, das serverseitig mit einem
// RLS-Fehler endet.

import { Button, Card, EmptyState, ErrorBanner, Input } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobComments } from "@/features/jobs/hooks/useJobComments";
import { formatDateISO, isSameLocalDate } from "@/utils/date";
import { isNetworkError } from "@/utils/networkError";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { toUserMessage } from "@/utils/userMessages";
import { i18next as i18nextInstance, INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";

// ─────────────────────────────────────────────
// Datums-/Zeit-Formatierung (analog JobDetailScreen)
// Heutige Kommentare: kompaktes "Heute um HH:mm" statt vollem Datum.
// Tagesvergleich über die zentralen Helfer aus utils/date.ts (formatDateISO +
// isSameLocalDate), damit "heute" überall im lokalen Kalendertag ausgewertet
// wird — keine eigene Duplikat-Logik hier. Sprachabhängig (i18next.language
// statt fest "de-DE") für Wochentag/Monatsname; das Zahlenformat (TT.MM.JJJJ)
// bleibt unverändert (Datumsformat-Phase, siehe i18n-Audit).
// ─────────────────────────────────────────────
function formatDateTime(
  iso: string | null | undefined,
  t: (key: string, opts: Record<string, string>) => string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const localeTag = INTL_LOCALE_TAGS[i18nextInstance.language as AppLocale] ?? "de-DE";
  const timePart = date.toLocaleTimeString(localeTag, {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSameLocalDate(formatDateISO(date), new Date())) {
    return t("jobs:comments.todayAt", { time: timePart });
  }

  const datePart = date.toLocaleDateString(localeTag, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return t("jobs:comments.dateAt", { date: datePart, time: timePart });
}

type JobCommentsProps = {
  jobId: string;
  /**
   * Darf der aktuelle Nutzer hier kommentieren? Pflicht-Prop (kein Default
   * `true`): ein vergessenes Prop soll die Eingabe ausblenden, nicht
   * fälschlich freischalten.
   */
  canComment: boolean;
  // Wird gerufen, wenn das Kommentarfeld fokussiert wird — der Screen scrollt
  // dann so, dass Eingabe + Senden über der Tastatur sichtbar bleiben.
  onInputFocus?: () => void;
};

export function JobComments({
  jobId,
  canComment,
  onInputFocus,
}: JobCommentsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t } = useTranslation();

  const { comments, loading, error, submit } = useJobComments(jobId);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const canSend = canComment && draft.trim().length > 0 && !submitting;

  const handleSend = async () => {
    setSubmitError("");
    try {
      setSubmitting(true);
      await submit(draft);
      setDraft("");
    } catch (err: unknown) {
      // Offline ist erwartbar (Kommentare sind online-only) — ruhige Meldung
      // statt der rohen "Network request failed"-Fehlermeldung.
      if (isNetworkError(err)) {
        setSubmitError(t("jobs:comments.offlineError"));
      } else {
        setSubmitError(
          toUserMessage(err, t("jobs:comments.sendFailed")),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      {/* ── Label ── */}
      <View style={styles.labelRow}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={12}
          color={theme.colors.primary}
        />
        <Text style={styles.label}>{t("jobs:comments.title")}</Text>
      </View>

      {/* ── Lade-/Fehler-/Listen-Zustand ── */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : error ? (
        /* Einheitliche Fehlerdarstellung statt nacktem rotem Text — gleiche
           Optik wie Sende-Fehler direkt darunter und in den Job-Screens. */
        <ErrorBanner message={error} />
      ) : comments.length === 0 ? (
        <EmptyState
          title={t("jobs:comments.emptyTitle")}
          message={t("jobs:comments.emptyMessage")}
          icon="chatbubble-outline"
          compact
        />
      ) : (
        <View style={styles.list}>
          {comments.map((comment) => (
            <View key={comment.id} style={styles.comment}>
              <View style={styles.commentHeader}>
                <Text style={styles.commentAuthor}>
                  {comment.authorName ?? t("jobs:comments.unknownAuthor")}
                </Text>
                <Text style={styles.commentTime}>
                  {formatDateTime(comment.createdAt, t) ?? ""}
                </Text>
              </View>
              <Text style={styles.commentText}>{comment.message}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ── Eingabe (nur mit Schreibrecht) ── */}
      {canComment ? (
        <View style={styles.inputWrap}>
          {submitError ? (
            <ErrorBanner
              message={submitError}
              onDismiss={() => setSubmitError("")}
            />
          ) : null}

          <Input
            placeholder={t("jobs:comments.placeholder")}
            value={draft}
            onChangeText={setDraft}
            onFocus={onInputFocus}
            multiline
            editable={!submitting}
          />
          <Button
            label={t("jobs:comments.send")}
            icon="send"
            loading={submitting}
            disabled={!canSend}
            onPress={handleSend}
          />
        </View>
      ) : (
        // Kein deaktivierter Button, sondern eine Erklärung: ein ausgegrautes
        // Feld ohne Grund wirkt wie ein Fehler.
        // Hinweis: Wortlaut ("hauptverantwortlicher Mitarbeiter") spiegelt
        // nicht mehr exakt die aktuelle Schreibrechte-Logik (canComment =
        // isAdmin || isAssignedTo, volle Zuweisungsmenge seit Migration
        // 20260826000001) — vorbestehende Abweichung, unverändert übernommen
        // (siehe i18n-Audit, nicht Teil dieser Übersetzungsphase).
        <Text style={styles.readOnlyHint}>
          {t("jobs:comments.readOnlyHint")}
        </Text>
      )}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },

    readOnlyHint: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      lineHeight: 20,
    },

    loadingWrap: {
      paddingVertical: theme.spacing.md,
      alignItems: "center",
    },

    // Liste
    list: {
      gap: theme.spacing.md,
    },
    comment: {
      gap: 2,
    },
    commentHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    commentAuthor: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
      flexShrink: 1,
    },
    commentTime: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
    commentText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurface,
      lineHeight: theme.typography.lineHeight.sm,
    },

    // Eingabe
    inputWrap: {
      gap: theme.spacing.sm,
    },
  });
}
