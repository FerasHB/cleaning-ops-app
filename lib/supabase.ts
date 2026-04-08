import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

// Supabase URL und Key aus den Env Variablen holen
// (!) bedeutet: wir gehen davon aus, dass sie sicher vorhanden sind
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

// Supabase Client erstellen (wird in der ganzen App verwendet)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Storage für Session:
    // - Web → Supabase nutzt eigenen Mechanismus
    // - Mobile → AsyncStorage wird verwendet
    storage: Platform.OS === "web" ? undefined : AsyncStorage,

    // Token automatisch erneuern (wichtig für Login dauerhaft)
    autoRefreshToken: true,

    // Session speichern (User bleibt eingeloggt)
    persistSession: true,

    // Für Web: erkennt Session aus URL (z.B. nach Redirect/Login)
    detectSessionInUrl: Platform.OS === "web",
  },
});