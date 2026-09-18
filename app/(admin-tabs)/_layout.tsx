// app/(admin-tabs)/_layout.tsx
// Bottom-Tab-Layout für den Admin-Bereich.
// Vollständig theme-aware: passt sich automatisch an Light/Dark Mode an.

import { useJobs } from "@/context/JobContext";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";

export default function AdminTabsLayout() {
  const theme = useAppTheme();
  const { hasUnread } = useJobs();
  const { t } = useTranslation();

  // Roter Punkt am Jobs-Tab, wenn irgendein Job ungelesene Kommentare hat.
  // Quelle ist die gebündelte Unread-Liste (RPC), unabhängig vom Ladefenster.
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
        name="dashboard"
        options={{
          title: t("admin:tabs.dashboard"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="jobs"
        options={{
          title: t("common:tabs.jobs"),
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
        name="kalender"
        options={{
          title: t("common:tabs.calendar"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="employees"
        options={{
          title: t("admin:tabs.employees"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: t("common:tabs.profile"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
