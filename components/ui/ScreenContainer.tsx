// components/ui/ScreenContainer.tsx
// ─────────────────────────────────────────────────────────────────
// Wrapper für alle Screens:
// SafeAreaView + optionaler ScrollView + horizontale Page-Margins.
// Vermeidet Copy-Paste von SafeAreaView/Padding in jedem Screen.
// ─────────────────────────────────────────────────────────────────

import { useAppTheme } from "@/hooks/useAppTheme";
import React, { useMemo } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface ScreenContainerProps {
  children: React.ReactNode;
  /** Scrollbar aktivieren (Standard: true) */
  scrollable?: boolean;
  /** Horizontales Padding deaktivieren (z.B. für Fullbleed-Layouts) */
  noPadding?: boolean;
  /** Zusätzlicher Style für den inneren Container */
  style?: ViewStyle;
  /** Tastatur-Ausweich-Verhalten aktivieren (Standard: false) */
  avoidKeyboard?: boolean;
}

export function ScreenContainer({
  children,
  scrollable = true,
  noPadding = false,
  style,
  avoidKeyboard = false,
}: ScreenContainerProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const content = scrollable ? (
    <ScrollView
      contentContainerStyle={[styles.scrollContent, noPadding && styles.noPadding, style]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.fixedContent, noPadding && styles.noPadding, style]}>
      {children}
    </View>
  );

  const wrapped = avoidKeyboard ? (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {content}
    </KeyboardAvoidingView>
  ) : content;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <StatusBar
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.background}
      />
      {wrapped}
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    flex: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.gutter,
      paddingBottom: 32,
    },
    fixedContent: {
      flex: 1,
      paddingHorizontal: theme.spacing.gutter,
    },
    noPadding: {
      paddingHorizontal: 0,
    },
  });
}
