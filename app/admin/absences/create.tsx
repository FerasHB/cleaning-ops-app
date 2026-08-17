import AdminCreateAbsenceScreen from "@/features/absences/admin/AdminCreateAbsenceScreen";
import { useLocalSearchParams } from "expo-router";

export default function AdminCreateAbsenceRoute() {
  const { employeeId } = useLocalSearchParams<{ employeeId?: string }>();
  return <AdminCreateAbsenceScreen preselectedEmployeeId={employeeId} />;
}
