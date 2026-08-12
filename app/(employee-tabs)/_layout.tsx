// app/(employee-tabs)/_layout.tsx
// Bottom-Tab-Layout für den Employee-Bereich.
// Vollständig theme-aware: passt sich automatisch an Light/Dark Mode an.

import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

export default function EmployeeTabsLayout() {
  const theme = useAppTheme();
  const { hasUnread } = useJobs();

  // Roter Punkt am Jobs-Tab, wenn irgendein Job ungelesene Kommentare hat.
  // Quelle ist die gebündelte Unread-Liste (RPC) — identisch zum Admin-Layout.
  // Vorher: jobs.some(...), das nur Jobs im aktuell geladenen Fenster sah; ein
  // ungelesener Kommentar außerhalb davon blieb ohne Punkt.
  const hasUnreadComments = hasUnread;

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
        name="overview"
        options={{
          title: "Übersicht",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
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
        name="profile"
        options={{
          // Deutsch wie der Rest der App ("Übersicht", "Jobs") — "Profile" war
          // das einzige englische Tab-Label.
          title: "Profil",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
