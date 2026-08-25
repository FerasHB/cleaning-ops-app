// services/auth/recoveryMode.ts
// ─────────────────────────────────────────────────────────────────
// SICHERHEITSGRENZE: unterscheidet eine REINE PASSWORT-RESET-SITZUNG von einer
// normalen App-Sitzung.
//
// Warum das nötig ist: `supabase.auth.exchangeCodeForSession()` erzeugt für
// einen Recovery-Link eine ganz normale, persistierte Supabase-Session und
// meldet sie als Event `SIGNED_IN` (NICHT `PASSWORD_RECOVERY` — geprüft in
// @supabase/auth-js 2.101.1, `_exchangeCodeForSession` ruft
// `_notifyAllSubscribers('SIGNED_IN', …)`). Supabase kennzeichnet die Session
// selbst also nicht als Recovery-Sitzung, und wegen `persistSession: true`
// überlebt sie App-Neustarts. Ohne eigene Markierung ist sie für die App
// von einem echten Login nicht unterscheidbar — der Nutzer landete nach einem
// Force-Close mitten im Reset-Flow beim nächsten Start in der voll
// authentifizierten App, OHNE je ein Passwort eingegeben zu haben.
//
// Der Besitz einer Recovery-Session berechtigt AUSSCHLIESSLICH dazu, das
// eigene Passwort zu ändern — nie dazu, die App zu betreten.
//
// Der Marker liegt bewusst in AsyncStorage (nicht nur im React-State), damit
// er Backgrounding, Force-Close, Kaltstart, Router-Remount und die
// Wiederherstellung der persistierten Supabase-Session übersteht.
// ─────────────────────────────────────────────────────────────────

import AsyncStorage from "@react-native-async-storage/async-storage";

const RECOVERY_MODE_KEY = "taskops-auth-recovery-mode";
const RECOVERY_MODE_VALUE = "1";

/**
 * Markiert die aktuelle/gleich entstehende Session als reine Recovery-Sitzung.
 * MUSS gesetzt werden, BEVOR der Code-/Token-Tausch akzeptiert wird — sonst
 * gibt es ein Zeitfenster, in dem eine bereits hergestellte Recovery-Session
 * noch als normale Session gilt.
 */
export async function markRecoveryModeActive(): Promise<void> {
  try {
    await AsyncStorage.setItem(RECOVERY_MODE_KEY, RECOVERY_MODE_VALUE);
  } catch {
    // Bewusst geschluckt: Schlägt das Schreiben fehl, greift weiterhin der
    // Route-Guard im laufenden Prozess (AuthContext-State). Verloren geht
    // dann nur die Persistenz über einen Neustart hinweg.
  }
}

/** Hebt die Recovery-Markierung auf (Reset abgeschlossen/abgebrochen/ungültig). */
export async function clearRecoveryMode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(RECOVERY_MODE_KEY);
  } catch {
    // best effort — siehe oben
  }
}

/** Liest den persistierten Marker (z.B. beim Kaltstart, vor der Routen-Entscheidung). */
export async function isRecoveryModePersisted(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(RECOVERY_MODE_KEY)) === RECOVERY_MODE_VALUE;
  } catch {
    // FAIL CLOSED wäre hier falsch: ohne lesbaren Marker gibt es auch keine
    // belegbare Recovery-Sitzung, und ein hängender Nutzer käme sonst nie
    // mehr in die App. Die Session selbst bleibt weiterhin durch den
    // normalen Auth-Guard geschützt.
    return false;
  }
}
