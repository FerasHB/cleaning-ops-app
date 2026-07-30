// features/jobs/components/JobLocationCard.tsx
// Adresse + Maps-Aktion. Reine Präsentationskomponente — der Screen behält
// die vollständige handleOpenInMaps-Implementierung (Plattform-URL-Schema),
// diese Komponente ruft sie nur über onOpenInMaps auf.

import { Button, Card, InfoRow } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  location: string;
  onOpenInMaps: () => void;
};

export function JobLocationCard({ location, onOpenInMaps }: Props) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const hasLocation = !!location?.trim();

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>
      <InfoRow
        label="Adresse"
        value={hasLocation ? location : "Keine Adresse hinterlegt"}
        icon="location-outline"
      />

      {hasLocation ? (
        <View style={styles.actionRow}>
          <Button
            label="In Maps öffnen"
            variant="secondary"
            icon="map-outline"
            fullWidth={false}
            onPress={onOpenInMaps}
            style={{ paddingHorizontal: theme.spacing.lg }}
            accessibilityRole="button"
            accessibilityLabel="Adresse in Maps öffnen"
          />
        </View>
      ) : (
        <View style={styles.emptyHint}>
          <Ionicons
            name="information-circle-outline"
            size={14}
            color={theme.colors.outline}
          />
          <Text style={styles.emptyHintText}>
            Für diesen Auftrag ist keine Adresse gepflegt.
          </Text>
        </View>
      )}
    </Card>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },
    actionRow: {
      flexDirection: "row",
    },
    emptyHint: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    emptyHintText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },
  });
}
