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
import { useIsRTL } from "@/hooks/useIsRTL";
import { formatDateISO, isSameLocalDate } from "@/utils/date";
import { INTL_LOCALE_TAGS, type AppLocale } from "@/i18n";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";

// Gleiche Zeitformatierung wie in JobComments: heutige Einträge kompakt,
// sprachabhängig über dieselben jobs:comments.todayAt/dateAt-Keys.
function formatDateTime(
  iso: string | null | undefined,
  t: (key: string, opts: Record<string, string>) => string,
  localeTag: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;

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

type Props = {
  /** Die Regel-ID. Der Aufrufer stellt sicher, dass nur Admins hier landen. */
  jobId: string;
};

export function RuleLegacyComments({ jobId }: Props) {
  const theme = useAppTheme();
  const isRTL = useIsRTL();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { t, i18n } = useTranslation();
  const localeTag = INTL_LOCALE_TAGS[i18n.language as AppLocale] ?? "de-DE";

  // Ausschließlich der Lesepfad des bestehenden Hooks — `submit` wird hier
  // bewusst nicht entgegengenommen.
  const { comments, loading, error } = useJobComments(jobId);

  const [open, setOpen] = useState(false);

  // Solange geladen wird, nichts anzeigen: ein Abschnitt, der auftaucht und
  // gleich wieder verschwindet, wirkt wie ein Fehler.
  if (loading) return null;

  // Scheitert der Abruf, bleibt der Abschnitt ebenfalls weg. Ihn trotzdem zu
  // zeigen, würde auf ALLEN Regeln Altbestand behaupten — auch auf den elf
  // von zwölf, die gar keinen haben. Kommentare sind ohnehin nur online
  // verfügbar; offline gibt es hier schlicht nichts zu zeigen.
  if (error) return null;

  // Ohne Bestand gibt es nichts zu bewahren — dann bleibt der Abschnitt weg.
  if (comments.length === 0) return null;

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => setOpen((value) => !value)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t("admin:recurringRules.legacyComments.a11yLabel", {
          count: comments.length,
        })}
        accessibilityHint={
          open
            ? t("admin:recurringRules.legacyComments.collapseHint")
            : t("admin:recurringRules.legacyComments.expandHint")
        }
      >
        <Ionicons
          name={open ? "chevron-down" : isRTL ? "chevron-back" : "chevron-forward"}
          size={16}
          color={theme.colors.onSurfaceVariant}
        />
        <Text style={styles.title} numberOfLines={1}>
          {t("admin:recurringRules.legacyComments.title")}
        </Text>
        <Text style={styles.count}>{comments.length}</Text>
      </TouchableOpacity>

      {open ? (
        <View style={styles.body}>
          <Text style={styles.legacyHint}>
            {t("admin:recurringRules.legacyComments.hint")}
          </Text>

          <View style={styles.list}>
            {comments.map((comment) => (
              <View key={comment.id} style={styles.comment}>
                <View style={styles.commentHeader}>
                  <Text style={styles.commentAuthor} numberOfLines={1}>
                    {comment.authorName ?? t("jobs:comments.unknownAuthor")}
                  </Text>
                  <Text style={styles.commentTime}>
                    {formatDateTime(comment.createdAt, t, localeTag) ?? ""}
                  </Text>
                </View>
                <Text style={styles.commentText}>{comment.message}</Text>
              </View>
            ))}
          </View>
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
