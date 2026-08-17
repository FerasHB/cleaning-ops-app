import AdminAbsencesScreen from "@/features/absences/admin/AdminAbsencesScreen";
import { useLocalSearchParams } from "expo-router";

export default function AdminAbsencesRoute() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  return (
    <AdminAbsencesScreen
      initialSegment={tab === "sickness" ? "sickness" : "vacation"}
    />
  );
}
