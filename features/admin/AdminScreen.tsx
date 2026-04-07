import { useJobs } from "@/context/JobContext";
import { useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
export default function AdminScreen() {
  const { createJob, employees, loading } = useJobs();

  const [customerName, setCustomerName] = useState("");
  const [location, setLocation] = useState("");
  const [service, setService] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleCreateJob = async () => {
    if (!customerName.trim() || !location.trim() || !service.trim()) {
      Alert.alert("Fehler", "Bitte Kunde, Ort und Service ausfüllen.");
      return;
    }

    try {
      setSubmitting(true);

      await createJob({
        customerName: customerName.trim(),
        location: location.trim(),
        service: service.trim(),
        employeeId,
        notes: notes.trim() || null,
      });

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
  // useEffect(() => {
  // debugCurrentUserAccess();
  //}, []);
  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Admin – Job erstellen</Text>

        <TextInput
          placeholder="Kunde"
          placeholderTextColor="#888"
          style={styles.input}
          value={customerName}
          onChangeText={setCustomerName}
        />

        <TextInput
          placeholder="Ort"
          placeholderTextColor="#888"
          style={styles.input}
          value={location}
          onChangeText={setLocation}
        />

        <TextInput
          placeholder="Service"
          placeholderTextColor="#888"
          style={styles.input}
          value={service}
          onChangeText={setService}
        />

        <TextInput
          placeholder="Notizen (optional)"
          placeholderTextColor="#888"
          style={[styles.input, styles.notesInput]}
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <Text style={styles.label}>Mitarbeiter auswählen</Text>

        <View style={styles.dropdown}>
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#121212",
  },
  container: {
    padding: 16,
    paddingBottom: 40,
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
    textAlignVertical: "top",
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
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
});
