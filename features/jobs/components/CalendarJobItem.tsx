// features/jobs/components/CalendarJobItem.tsx
// ─────────────────────────────────────────────────────────────────
// Kompakter Job-Eintrag INNERHALB einer Kalender-Tageszelle.
//
// Bewusst extrem leichtgewichtig: im Monatsraster können bis zu ~90 dieser
// Einträge gleichzeitig stehen (42 Zellen × bis zu 3 Einträge). Deshalb hier
// KEIN JobCard — kein Statusbadge, keine Live-Arbeitszeit (useJobWorkedTime
// tickt jede Sekunde), keine Assignee-Auflösung, keine Schatten.
//
// WARUM ZWEIZEILIG (Uhrzeit über Kunde) statt „08:00 Müller" in einer Zeile:
// eine Spalte des Monatsrasters ist auf einem Telefon rund 50 px breit. Davon
// verbraucht „08:00" allein etwa die Hälfte — nebeneinander blieben für den
// Kundennamen zwei bis drei Zeichen, also faktisch nur „Mü…". Übereinander
// bekommt der Name die volle Spaltenbreite, und weil Höhe im Raster reichlich
// vorhanden ist (Breite dagegen nicht), kostet das nichts an Einträgen.
//
// Status-Signal: schmale farbige Kante links über beide Zeilen. Die Farbe
// kommt aus der gemeinsamen Quelle `utils/jobStatus.ts` (getJobStatusMeta) —
// es gibt bewusst KEINE zweite Status-Farbtabelle. Ein Badge wäre bei dieser
// Spaltenbreite nicht unterzubringen.
// ─────────────────────────────────────────────────────────────────

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import type { Job } from "@/types/job";
import { getJobDisplayTime } from "@/utils/jobSchedule";
import { getJobStatusMeta } from "@/utils/jobStatus";
import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

/** Feste Eintragshöhe — das Raster rechnet damit, wie viele Einträge passen. */
export const CALENDAR_JOB_ITEM_HEIGHT = 25;

type Props = {
  job: Job;
  onPress: () => void;
  /** Tag außerhalb des angezeigten Monats → gedämpft. */
  muted?: boolean;
};

function CalendarJobItemBase({ job, onPress, muted = false }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const status = getJobStatusMeta(job.status, theme.colors);

  const time = getJobDisplayTime(job);

  return (
    <TouchableOpacity
      style={[styles.row, muted && styles.rowMuted]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      // Der sichtbare Eintrag ist winzig — der Screenreader bekommt den
      // vollständigen Satz inkl. kanonischem Statuswort.
      accessibilityLabel={`${time ? `${time} Uhr, ` : ""}${job.customerName}, ${status.label}`}
    >
      <View style={[styles.edge, { backgroundColor: status.text }]} />

      <View style={styles.texts}>
        {time ? (
          // Uhrzeit wird nie skaliert oder gekürzt — sie ist die Information,
          // wegen der ein Blick auf den Monat überhaupt reicht.
          <Text style={styles.time} numberOfLines={1} maxFontSizeMultiplier={1.1}>
            {time}
          </Text>
        ) : null}
        <Text
          style={styles.customer}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={1.1}
        >
          {job.customerName}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

/** Memoisiert: beim Blättern rendern sonst alle Einträge des Monats neu. */
export const CalendarJobItem = React.memo(CalendarJobItemBase);

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      height: CALENDAR_JOB_ITEM_HEIGHT,
      flexDirection: "row",
      alignItems: "stretch",
      borderRadius: 3,
      backgroundColor: theme.colors.surfaceContainerHigh,
      // Schneidet zu lange Inhalte hart an der Zellgrenze ab — nichts läuft
      // je in die Nachbarspalte.
      overflow: "hidden",
    },
    rowMuted: {
      opacity: 0.45,
    },
    // Status-Kante: das einzige Farbsignal im Eintrag, über beide Zeilen.
    edge: {
      width: 2.5,
    },
    texts: {
      flex: 1,
      // minWidth:0 verhindert, dass ein langer Kundenname den Eintrag (und
      // damit die Spalte) breiter zieht, statt gekürzt zu werden.
      minWidth: 0,
      paddingHorizontal: 3,
      justifyContent: "center",
    },
    time: {
      fontSize: 9,
      lineHeight: 11,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.onSurfaceVariant,
    },
    customer: {
      fontSize: 10,
      lineHeight: 12,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.onSurface,
    },
  });
}
