// features/jobs/components/JobComments.tsx
// Kommentar-Sektion für einen Job (append-only, MVP).
// Liste (Autor, Zeit, Text) + Eingabe. Employee und Admin dürfen schreiben.
// Online-only — nutzt useJobComments (kein JobContext, keine Offline-Queue).

import { Button, Card, ErrorBanner, Input } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobComments } from "@/features/jobs/hooks/useJobComments";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

// ─────────────────────────────────────────────
// Datums-/Zeit-Formatierung (analog JobDetailScreen)
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

type JobCommentsProps = {
  jobId: string;
};

export function JobComments({ jobId }: JobCommentsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { comments, loading, error, submit } = useJobComments(jobId);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const canSend = draft.trim().length > 0 && !submitting;

  const handleSend = async () => {
    setSubmitError("");
    try {
      setSubmitting(true);
      await submit(draft);
      setDraft("");
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Kommentar konnte nicht gesendet werden.",
      );
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
        <Text style={styles.label}>KOMMENTARE</Text>
      </View>

      {/* ── Lade-/Fehler-/Listen-Zustand ── */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : comments.length === 0 ? (
        <Text style={styles.emptyText}>Noch keine Kommentare</Text>
      ) : (
        <View style={styles.list}>
          {comments.map((comment) => (
            <View key={comment.id} style={styles.comment}>
              <View style={styles.commentHeader}>
                <Text style={styles.commentAuthor}>
                  {comment.authorName ?? "Unbekannt"}
                </Text>
                <Text style={styles.commentTime}>
                  {formatDateTime(comment.createdAt) ?? ""}
                </Text>
              </View>
              <Text style={styles.commentText}>{comment.message}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ── Eingabe ── */}
      <View style={styles.inputWrap}>
        {submitError ? (
          <ErrorBanner
            message={submitError}
            onDismiss={() => setSubmitError("")}
          />
        ) : null}

        <Input
          placeholder="Kommentar schreiben…"
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!submitting}
        />
        <Button
          label="Senden"
          icon="send"
          loading={submitting}
          disabled={!canSend}
          onPress={handleSend}
        />
      </View>
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

    loadingWrap: {
      paddingVertical: theme.spacing.md,
      alignItems: "center",
    },
    errorText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.error,
    },
    emptyText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
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
