import { supabase } from "@/lib/supabase";
import React, { useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

// Einfacher Login-Screen für die App
export default function LoginScreen() {
  // States für Eingaben und Ladezustand
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Login-Funktion
  const handleLogin = async () => {
    // Kleine Prüfung: beide Felder müssen ausgefüllt sein
    if (!email || !password) {
      Alert.alert("Fehler", "Bitte E-Mail und Passwort eingeben.");
      return;
    }

    try {
      setLoading(true);

      // Login mit Supabase
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(), // Leerzeichen am Anfang/Ende entfernen
        password,
      });

      // Falls Supabase einen Fehler zurückgibt
      if (error) {
        Alert.alert("Login fehlgeschlagen", error.message);
      }
    } catch (error) {
      // Falls allgemein etwas schiefgeht
      Alert.alert("Fehler", "Login konnte nicht durchgeführt werden.");
      console.error("Login error:", error);
    } finally {
      // Egal ob Erfolg oder Fehler → Loading wieder aus
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Überschrift */}
      <Text style={styles.title}>Login</Text>

      {/* Eingabe für E-Mail */}
      <TextInput
        style={styles.input}
        placeholder="E-Mail"
        placeholderTextColor="#888"
        autoCapitalize="none" // damit nichts automatisch groß geschrieben wird
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      {/* Eingabe für Passwort */}
      <TextInput
        style={styles.input}
        placeholder="Passwort"
        placeholderTextColor="#888"
        secureTextEntry // Passwort wird versteckt angezeigt
        value={password}
        onChangeText={setPassword}
      />

      {/* Login-Button */}
      <Pressable style={styles.button} onPress={handleLogin} disabled={loading}>
        <Text style={styles.buttonText}>
          {loading ? "Lade..." : "Einloggen"}
        </Text>
      </Pressable>
    </View>
  );
}

// Styles für den Login-Screen
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#121212",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 24,
  },
  input: {
    backgroundColor: "#1e1e1e",
    color: "#fff",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#3b82f6",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
