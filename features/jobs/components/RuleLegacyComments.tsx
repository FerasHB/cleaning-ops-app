// features/jobs/components/RuleLegacyComments.tsx
// „Kommentare zur Regel" — eingeklappter, NUR-LESEN-Abschnitt für Kommentare,
// die direkt an einer Dauerauftrags-Regel hängen.
//
// HINTERGRUND: die alte Detailansicht rendert für Regeln dieselbe
// Kommentar-Sektion wie für ausführbare Termine, inklusive Eingabefeld. Eine
// Regel ist aber eine Vorlage — und Mitarbeitende bekommen Parent-Regeln in
// keiner Liste zu sehen, ein Kommentar dort erreicht also niemanden. Eine
// Bestandsprüfung auf der Produktivdatenbank (31.07.2026, rein lesend) ergab
// genau EINEN solchen Kommentar an einer von zwölf Regeln, geschrieben am
// Anlegetag der Regel und seither ohne Folgeeintrag — Altbestand, kein
// gelebter Arbeitsablauf.
//
// KONSEQUENZ: der Bestand bleibt vollständig erreichbar, aber als das, was er
// ist — ein Altbestand. Deshalb:
//   • eingeklappt, öffnet nur auf ausdrückliches Antippen
//   • KEIN Eingabefeld, kein Anlegen/Ändern/Löschen von hier aus
//   • der Abschnitt erscheint überhaupt nur, wenn es Kommentare gibt
//   • nur für Admins (der Aufrufer entscheidet, siehe RecurringRuleDetailScreen)
//
// Am Datensatz, an den Policies und an den Kommentar-Services ändert sich
// nichts. Neue Kommentare zu Regeln entstehen schlicht nicht mehr über die UI.

import { Card } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobComments } from "@/features/jobs/hooks/useJobComments";
import { useAppTheme } from "@/hooks/useAppTheme";
import { formatDateISO, isSameLocalDate } from "@/utils/date";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

// Gleiche Zeitformatierung wie in JobComments: heutige Einträge kompakt.
function formatDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

  const timePart = date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSameLocalDate(formatDateISO(date), new Date())) {
    return `Heute um ${timePart}`;
  }

  const datePart = date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `${datePart} um ${timePart}`;
}

type Props = {
  /** Die Regel-ID. Der Aufrufer stellt sicher, dass nur Admins hier landen. */
  jobId: string;
};

export function RuleLegacyComments({ jobId }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Ausschließlich der Lesepfad des bestehenden Hooks — `submit` wird hier
  // bewusst nicht entgegengenommen.
  const { comments, loading, error } = useJobComments(jobId);

  const [open, setOpen] = useState(false);

  // Solange geladen wird, nichts anzeigen: ein Abschnitt, der auftaucht und
  // gleich wieder verschwindet, wirkt wie ein Fehler.
  if (loading) return null;

  // Ohne Bestand gibt es nichts zu bewahren — dann bleibt der Abschnitt weg.
  if (!error && comments.length === 0) return null;

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => setOpen((value) => !value)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          error
            ? "Kommentare zur Regel"
            : `Kommentare zur Regel, ${comments.length} ${
                comments.length === 1 ? "Eintrag" : "Einträge"
              }`
        }
        accessibilityHint={open ? "Zum Einklappen antippen" : "Zum Aufklappen antippen"}
      >
        <Ionicons
          name={open ? "chevron-down" : "chevron-forward"}
          size={16}
          color={theme.colors.onSurfaceVariant}
        />
        <Text style={styles.title} numberOfLines={1}>
          Kommentare zur Regel
        </Text>
        {!error ? (
          <Text style={styles.count}>{comments.length}</Text>
        ) : null}
      </TouchableOpacity>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.legacyHint}>
            Altbestand: Kommentare an einer Regel erreichen keine Mitarbeitenden.
            Sie werden hier nur noch zur Einsicht angezeigt. Schreibe Kommentare
            stattdessen am konkreten Termin.
          </Text>

          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <View style={styles.list}>
              {comments.map((comment) => (
                <View key={comment.id} style={styles.comment}>
                  <View style={styles.commentHeader}>
                    <Text style={styles.commentAuthor} numberOfLines={1}>
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
        </View>
      ) : null}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.sm,
    },
    toggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      minHeight: theme.spacing.tapTarget,
    },
    title: {
      flex: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    count: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurfaceVariant,
    },

    body: {
      gap: theme.spacing.md,
    },
    legacyHint: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.xs,
      color: theme.colors.onSurfaceVariant,
    },
    errorText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.error,
    },

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
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurface,
    },
    commentTime: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
    commentText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      lineHeight: theme.typography.lineHeight.sm,
      color: theme.colors.onSurface,
    },
  });
}
