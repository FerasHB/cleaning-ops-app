// app/(admin-tabs)/_layout.tsx
// Bottom-Tab-Layout für den Admin-Bereich.
// Vollständig theme-aware: passt sich automatisch an Light/Dark Mode an.

import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

export default function AdminTabsLayout() {
  const theme = useAppTheme();
  const { jobs } = useJobs();

  // Roter Punkt am Jobs-Tab, wenn irgendein Job ungelesene Kommentare hat.
  const hasUnreadComments = jobs.some((job) => job.hasUnreadComments);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.outlineVariant,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        tabBarLabelStyle: {
          fontFamily: theme.typography.family.medium,
          fontSize: theme.typography.size.xs,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="jobs"
        options={{
          title: "Jobs",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size} color={color} />
          ),
          // Kleiner roter Punkt (leeres Badge) bei ungelesenen Kommentaren.
          tabBarBadge: hasUnreadComments ? "" : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.error,
            minWidth: 10,
            maxWidth: 10,
            minHeight: 10,
            maxHeight: 10,
            borderRadius: 5,
          },
        }}
      />

      <Tabs.Screen
        name="employees"
        options={{
          title: "Mitarbeiter",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
