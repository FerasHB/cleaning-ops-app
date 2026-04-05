import { Stack } from "expo-router";
import { JobProvider } from "../context/JobContext";

export default function RootLayout() {
  return (
    <JobProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </JobProvider>
  );
}
