// features/jobs/components/OccurrenceOriginLink.tsx
// Rückweg von einem generierten Termin zu seiner Dauerauftrags-Regel.
//
// WARUM: `parentJobId` liegt auf jedem generierten Termin, wurde aber nirgends
// für Navigation genutzt. Ein Termin war damit eine Sackgasse — weder aus dem
// Zeitplan noch aus der Terminliste der Regel selbst kam man zur Regel zurück.
// Stattdessen standen ZWEI nicht antippbare Hinweise auf demselben Screen
// („Teil eines Dauerauftrags" in der Kopfzeile, „Generierter Termin eines
// Dauerauftrags." in der Terminierungs-Karte). Beide sind entfallen; hier
// steht jetzt genau ein Element, das denselben Sachverhalt trägt UND führt.
//
// ROBUSTHEIT:
//   • Der Name der Regel wird über den bestehenden getJobById geladen — ein
//     zusätzlicher Lesevorgang, kein Service-Umbau.
//   • Pro Bildschirm-Lebensdauer wird höchstens EINMAL je parentJobId geladen
//     (Ref-Wächter, zusätzlich zum Effect-Cleanup).
//   • Die Zeile ist IMMER antippbar, sobald parentJobId existiert — auch
//     während des Ladens und auch dann, wenn die Regel nicht gelesen werden
//     kann (gelöscht, keine Berechtigung). In diesen Fällen lautet die
//     Beschriftung schlicht „Zum Dauerauftrag".

import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { getJobById } from "@/services/jobs/jobs.service";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const FALLBACK_LABEL = "Zum Dauerauftrag";

type Props = {
  parentJobId: string;
};

export function OccurrenceOriginLink({ parentJobId }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [parentName, setParentName] = useState<string | null>(null);
  // Merkt sich, für welche ID bereits ein Abruf gestartet wurde. Verhindert
  // einen zweiten Netzaufruf, wenn der Effect erneut läuft (Re-Render,
  // StrictMode-Doppelmount), ohne den Wechsel auf eine andere ID zu blockieren.
  const requestedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!parentJobId) return;
    if (requestedForRef.current === parentJobId) return;
    requestedForRef.current = parentJobId;

    let cancelled = false;
    getJobById(parentJobId)
      .then((parent) => {
        if (!cancelled) setParentName(parent?.customerName ?? null);
      })
      .catch(() => {
        // Kein Fehler-UI: die Navigation funktioniert weiterhin, nur der Name
        // fehlt. Der Fallback-Text trägt die Bedeutung allein.
        if (!cancelled) setParentName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [parentJobId]);

  const label = parentName ? `Teil von: ${parentName}` : FALLBACK_LABEL;

  return (
    <Pressable
      onPress={() => router.push(`/jobs/${parentJobId}`)}
      accessibilityRole="button"
      accessibilityLabel={
        parentName
          ? `Dauerauftrag ${parentName} öffnen`
          : "Zugehörigen Dauerauftrag öffnen"
      }
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Ionicons name="repeat-outline" size={14} color={theme.colors.primary} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.spacer} />
      <Ionicons
        name="chevron-forward"
        size={14}
        color={theme.colors.primary}
      />
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.outlineVariant,
      backgroundColor: theme.colors.surfaceContainer,
      minHeight: theme.spacing.tapTarget,
    },
    rowPressed: { opacity: 0.7 },
    label: {
      flexShrink: 1,
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.primary,
    },
    spacer: { flex: 1 },
  });
}
