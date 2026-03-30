import { Stack } from "expo-router";
import { JobProvider } from "../data/JobContext";

export default function RootLayout() {
  return (
    <JobProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </JobProvider>
  );
}
