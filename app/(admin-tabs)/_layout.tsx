import { Colors } from "@/constants/theme";
import { Tabs } from "expo-router";

export default function AdminTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.bg.surface,
          borderTopColor: Colors.border.default,
        },
        tabBarActiveTintColor: Colors.accent.default,
        tabBarInactiveTintColor: Colors.text.muted,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Übersicht",
        }}
      />

      <Tabs.Screen
        name="jobs"
        options={{
          title: "Jobs",
        }}
      />

      <Tabs.Screen
        name="employees"
        options={{
          title: "Mitarbeiter",
        }}
      />
    </Tabs>
  );
}
