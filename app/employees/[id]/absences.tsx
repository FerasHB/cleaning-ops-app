import EmployeeAbsenceHistoryScreen from "@/features/absences/admin/EmployeeAbsenceHistoryScreen";
import { useLocalSearchParams } from "expo-router";

export default function EmployeeAbsenceHistoryRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EmployeeAbsenceHistoryScreen employeeId={id} />;
}
