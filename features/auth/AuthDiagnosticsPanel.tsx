// features/auth/AuthDiagnosticsPanel.tsx
// ─────────────────────────────────────────────────────────────────
// TEMPORÄR — NUR FÜR DIE DIAGNOSE DES INTERMITTIERENDEN PKCE-RECOVERY-FEHLERS.
// Vor dem Merge ersatzlos entfernen (siehe utils/authDiagnostics.ts).
//
// Rendert NICHTS, solange AUTH_DIAGNOSTICS_ENABLED falsch ist — in einem
// normalen Production-Build (ohne EXPO_PUBLIC_AUTH_DIAGNOSTICS=1) ist dieser
// Bereich also unsichtbar, unabhängig davon, wo die Komponente eingebunden
// wird.
//
// Zeigt die Anzahl aufgezeichneter Diagnose-Events und bietet zwei Aktionen:
//   • "Auth-Diagnose kopieren" — kopiert den gesamten Puffer als Text in die
//     Zwischenablage, damit er ohne macOS Console aus der App heraus
//     verschickt werden kann.
//   • "Auth-Diagnose löschen" — leert den Puffer für den nächsten Testlauf.
// ─────────────────────────────────────────────────────────────────

import {
  addDiagnosticEvent,
  clearDiagnosticEvents,
  getDiagnosticEventsCount,
  getDiagnosticEventsText,
} from "@/utils/authDiagnosticsBuffer";
import { AUTH_DIAGNOSTICS_ENABLED } from "@/utils/authDiagnostics";
import * as Clipboard from "expo-clipboard";
import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

export function AuthDiagnosticsPanel() {
  // Re-render bei jedem Öffnen erzwingen, damit die Zähler-Anzeige aktuell
  // bleibt, ohne den Buffer selbst in React-State zu duplizieren.
  const [, forceRender] = useState(0);

  if (!AUTH_DIAGNOSTICS_ENABLED) {
    return null;
  }

  const handleCopy = async () => {
    const text = getDiagnosticEventsText();
    await Clipboard.setStringAsync(text);
    addDiagnosticEvent("[Diagnose] Buffer in Zwischenablage kopiert.");
    forceRender((n) => n + 1);
  };

  const handleClear = async () => {
    await clearDiagnosticEvents();
    forceRender((n) => n + 1);
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        Auth-Diagnose (temporär) — {getDiagnosticEventsCount()} Ereignisse
      </Text>
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={handleCopy} activeOpacity={0.8}>
          <Text style={styles.btnText}>Auth-Diagnose kopieren</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={handleClear}
          activeOpacity={0.8}
        >
          <Text style={styles.btnText}>Auth-Diagnose löschen</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#F59E0B",
    backgroundColor: "#FEF3C7",
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: "700",
    color: "#92400E",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#F59E0B",
    alignItems: "center",
  },
  btnSecondary: {
    backgroundColor: "#D97706",
  },
  btnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1F2937",
  },
});
