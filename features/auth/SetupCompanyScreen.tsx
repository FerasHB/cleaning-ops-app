import { useAuth } from "@/context/AuthContext";
import { setupCompanyForAdmin } from "@/services/company/setupCompanyForAdmin";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

export function SetupCompanyScreen() {
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const { refreshProfile } = useAuth();

  const handleSubmit = async () => {
    if (!companyName.trim()) {
      Alert.alert("Fehler", "Bitte gib einen Firmennamen ein.");
      return;
    }

    try {
      setLoading(true);
      await setupCompanyForAdmin(companyName);
      await refreshProfile();
      router.replace("/home");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Firma konnte nicht erstellt werden.";

      Alert.alert("Fehler", message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Firma einrichten</Text>
        <Text style={styles.subtitle}>
          Erstelle zuerst deine Firma. Dein Account wird danach automatisch als
          Admin eingerichtet.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Firmenname"
          placeholderTextColor="#888"
          value={companyName}
          onChangeText={setCompanyName}
          editable={!loading}
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.buttonText}>Firma erstellen</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0B0F",
  },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: "#b3b3b3",
    marginBottom: 24,
  },
  input: {
    backgroundColor: "#17171C",
    borderWidth: 1,
    borderColor: "#2A2A33",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: "#fff",
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "700",
  },
});
