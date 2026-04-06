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

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert("Fehler", "Bitte E-Mail und Passwort eingeben.");
      return;
    }

    try {
      setLoading(true);

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        Alert.alert("Login fehlgeschlagen", error.message);
      }
    } catch (error) {
      Alert.alert("Fehler", "Login konnte nicht durchgeführt werden.");
      console.error("Login error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Login</Text>

      <TextInput
        style={styles.input}
        placeholder="E-Mail"
        placeholderTextColor="#888"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      <TextInput
        style={styles.input}
        placeholder="Passwort"
        placeholderTextColor="#888"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <Pressable style={styles.button} onPress={handleLogin} disabled={loading}>
        <Text style={styles.buttonText}>
          {loading ? "Lade..." : "Einloggen"}
        </Text>
      </Pressable>
    </View>
  );
}

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
