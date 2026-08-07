import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

let notificationsConfigured = false;

export function setupNotifications() {
  if (notificationsConfigured) {
    return;
  }

  // PLATTFORM-GUARD (Web): expo-notifications ist im Browser nicht
  // implementiert. Es gibt dort keine Push-Tokens (siehe
  // registerForPushNotifications unten, das seit jeher früh mit null
  // zurückkehrt), also auch nichts zu konfigurieren. Ohne diesen Guard hinge
  // die Web-Tauglichkeit der App am Wohlwollen einer nicht unterstützten
  // Plattform-API. Früher Ausstieg, BEVOR notificationsConfigured gesetzt
  // wird — so bleibt der Aufruf auf einer künftig unterstützten Plattform
  // wiederholbar.
  if (Platform.OS === "web") {
    return;
  }

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  notificationsConfigured = true;
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2563EB",
    });
  }

  if (!Device.isDevice) return null;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") return null;

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ??
    Constants?.easConfig?.projectId;

  if (!projectId) return null;

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

  if (__DEV__) {
    console.log("Expo push token:", token);
  }

  return token;
}