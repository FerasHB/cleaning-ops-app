import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View, // ✅ WICHTIG (hat gefehlt)
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useJobs } from "../../data/JobContext";
import { employees } from "../../data/employees";

export default function AdminScreen() {
  const { addJob } = useJobs();

  const [customer, setCustomer] = useState("");
  const [location, setLocation] = useState("");
  const [time, setTime] = useState("");
  const [service, setService] = useState("");
  const [employee, setEmployee] = useState("");

  const handleAddJob = () => {
    if (!customer || !location || !employee) return; // ✅ verbessert

    addJob({
      id: Date.now().toString(),
      customer,
      location,
      time,
      service,
      employee,
      status: "Open",
    });

    setCustomer("");
    setLocation("");
    setTime("");
    setService("");
    setEmployee("");
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Admin – Job erstellen</Text>

        <TextInput
          placeholder="Kunde"
          placeholderTextColor="#888"
          style={styles.input}
          value={customer}
          onChangeText={setCustomer}
        />

        <TextInput
          placeholder="Ort"
          placeholderTextColor="#888"
          style={styles.input}
          value={location}
          onChangeText={setLocation}
        />

        <TextInput
          placeholder="Zeit"
          placeholderTextColor="#888"
          style={styles.input}
          value={time}
          onChangeText={setTime}
        />

        <TextInput
          placeholder="Service"
          placeholderTextColor="#888"
          style={styles.input}
          value={service}
          onChangeText={setService}
        />

        {/* Dropdown */}
        <Text style={styles.label}>Mitarbeiter auswählen</Text>

        <View style={styles.dropdown}>
          {employees.map((emp) => {
            const isSelected = employee === emp.name;

            return (
              <TouchableOpacity
                key={emp.id}
                style={[
                  styles.employeeItem,
                  isSelected && styles.selectedEmployee,
                ]}
                onPress={() => setEmployee(emp.name)}
              >
                <Text
                  style={[
                    styles.employeeText,
                    isSelected && styles.selectedEmployeeText,
                  ]}
                >
                  {emp.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity style={styles.button} onPress={handleAddJob}>
          <Text style={styles.buttonText}>Job erstellen</Text>
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
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
});
