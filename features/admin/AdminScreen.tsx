import { useAuth } from "@/context/AuthContext";
import { useJobs } from "@/context/JobContext";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Admin-Bereich zum Erstellen neuer Jobs
export default function AdminScreen() {
  // Aus dem JobContext holen wir die Funktion zum Erstellen,
  // die Mitarbeiterliste und den Ladezustand
  const { createJob, employees, loading } = useJobs();

  // Aus dem AuthContext holen wir Logout, Rolle und Auth-Loading
  const { signOut, role, loading: authLoading } = useAuth();

  // Formular-State für die Eingabefelder
  const [customerName, setCustomerName] = useState("");
  const [location, setLocation] = useState("");
  const [service, setService] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  // Extra State, damit man während dem Absenden nicht doppelt klickt
  const [submitting, setSubmitting] = useState(false);

  // Logout-Funktion
  const handleLogout = async () => {
    try {
      await signOut();
    } catch (err: any) {
      Alert.alert("Fehler", err?.message ?? "Abmeldung fehlgeschlagen.");
    }
  };

  // Job erstellen
  const handleCreateJob = async () => {
    // Kleine Validierung: die wichtigsten Felder müssen ausgefüllt sein
    if (!customerName.trim() || !location.trim() || !service.trim()) {
      Alert.alert("Fehler", "Bitte Kunde, Ort und Service ausfüllen.");
      return;
    }

    try {
      setSubmitting(true);

      // Job an den Context / Service schicken
      await createJob({
        customerName: customerName.trim(),
        location: location.trim(),
        service: service.trim(),
        employeeId,
        notes: notes.trim() || null, // leere Notizen als null speichern
      });

      // Nach Erfolg Formular zurücksetzen
      setCustomerName("");
      setLocation("");
      setService("");
      setEmployeeId(null);
      setNotes("");

      Alert.alert("Erfolg", "Job wurde erstellt.");
    } catch (err: any) {
      Alert.alert(
        "Fehler",
        err?.message ?? "Job konnte nicht erstellt werden.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Wenn Auth noch lädt → Spinner anzeigen
  if (authLoading) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeAreaCentered}>
        <ActivityIndicator size="large" color="#2563EB" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Zurück zur vorherigen Seite */}
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backButton}>← Zurück</Text>
        </TouchableOpacity>

        {/* Logout Button */}
        <TouchableOpacity onPress={handleLogout} style={styles.logoutButton}>
          <Text style={styles.logoutButtonText}>Abmelden</Text>
        </TouchableOpacity>

        {/* Zeigt zur Kontrolle die aktuelle Rolle */}
        <Text style={styles.roleText}>Rolle: {role ?? "unbekannt"}</Text>

        {/* Titel vom Screen */}
        <Text style={styles.title}>Admin – Job erstellen</Text>

        {/* Kunde eingeben */}
        <TextInput
          placeholder="Kunde"
          placeholderTextColor="#888"
          style={styles.input}
          value={customerName}
          onChangeText={setCustomerName}
        />

        {/* Ort eingeben */}
        <TextInput
          placeholder="Ort"
          placeholderTextColor="#888"
          style={styles.input}
          value={location}
          onChangeText={setLocation}
        />

        {/* Service eingeben */}
        <TextInput
          placeholder="Service"
          placeholderTextColor="#888"
          style={styles.input}
          value={service}
          onChangeText={setService}
        />

        {/* Notizen sind optional */}
        <TextInput
          placeholder="Notizen (optional)"
          placeholderTextColor="#888"
          style={[styles.input, styles.notesInput]}
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        {/* Bereich zur Mitarbeiterauswahl */}
        <Text style={styles.label}>Mitarbeiter auswählen</Text>

        <View style={styles.dropdown}>
          {/* Option: Job erstmal niemandem zuweisen */}
          <TouchableOpacity
            style={[
              styles.employeeItem,
              employeeId === null && styles.selectedEmployee,
            ]}
            onPress={() => setEmployeeId(null)}
          >
            <Text
              style={[
                styles.employeeText,
                employeeId === null && styles.selectedEmployeeText,
              ]}
            >
              Nicht zuweisen
            </Text>
          </TouchableOpacity>

          {/* Liste aller verfügbaren Mitarbeiter */}
          {employees.map((emp) => {
            const isSelected = employeeId === emp.id;

            return (
              <TouchableOpacity
                key={emp.id}
                style={[
                  styles.employeeItem,
                  isSelected && styles.selectedEmployee,
                ]}
                onPress={() => setEmployeeId(emp.id)}
              >
                <Text
                  style={[
                    styles.employeeText,
                    isSelected && styles.selectedEmployeeText,
                  ]}
                >
                  {emp.fullName}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Button zum Erstellen des Jobs */}
        <TouchableOpacity
          style={[
            styles.button,
            (submitting || loading) && styles.buttonDisabled,
          ]}
          onPress={handleCreateJob}
          disabled={submitting || loading}
        >
          <Text style={styles.buttonText}>
            {submitting ? "Wird erstellt..." : "Job erstellen"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// Styles für den AdminScreen
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#121212",
  },
  safeAreaCentered: {
    flex: 1,
    backgroundColor: "#121212",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  backButton: {
    color: "#A1A1AA",
    marginBottom: 10,
  },
  logoutButton: {
    backgroundColor: "#27272A",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 16,
  },
  logoutButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  roleText: {
    color: "#A1A1AA",
    marginBottom: 8,
  },
  title: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 20,
  },
  input: {
    backgroundColor: "#1E1E1E",
    color: "#fff",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
  },
  notesInput: {
    minHeight: 100,
    textAlignVertical: "top", // Text startet oben links bei multiline
  },
  label: {
    color: "#A1A1AA",
    marginBottom: 8,
    marginTop: 10,
  },
  dropdown: {
    backgroundColor: "#1E1E1E",
    borderRadius: 10,
    padding: 8,
    marginBottom: 12,
  },
  employeeItem: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
  selectedEmployee: {
    backgroundColor: "#2563EB",
  },
  employeeText: {
    color: "#fff",
  },
  selectedEmployeeText: {
    color: "#fff",
    fontWeight: "700",
  },
  button: {
    backgroundColor: "#2563EB",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 10,
  },
  buttonDisabled: {
    opacity: 0.6, // zeigt optisch, dass der Button gerade deaktiviert ist
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
});
