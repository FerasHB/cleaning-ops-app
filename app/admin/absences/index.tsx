import AdminAbsencesScreen from "@/features/absences/admin/AdminAbsencesScreen";
import { useLocalSearchParams } from "expo-router";

export default function AdminAbsencesRoute() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const initialSegment =
    tab === "absent" ? "absent" : tab === "sickness" ? "sickness" : "vacation";
  return <AdminAbsencesScreen initialSegment={initialSegment} />;
}
