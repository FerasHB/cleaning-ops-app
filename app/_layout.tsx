import { Stack } from "expo-router";
import { AuthProvider } from "../context/AuthContext";
import { JobProvider } from "../context/JobContext";
export default function RootLayout() {
  return (
    <AuthProvider>
      <JobProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </JobProvider>
    </AuthProvider>
  );
}
