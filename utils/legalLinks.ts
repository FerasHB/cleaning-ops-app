// utils/legalLinks.ts
// Öffentliche Rechtstexte der App (Store-Compliance: Apple 5.1.1(i) verlangt
// einen Datenschutz-Link IN der App, Google Play zusätzlich eine Web-URL für
// Kontolöschungs-Anfragen).
//
// Die URLs stehen in app.json unter expo.extra.legal — EIN Ort, kein
// Staging-/Produktions-Unterschied (öffentliche Webseiten, unabhängig vom
// Backend). Sie werden in den Build eingebacken: vor jedem Store-Build müssen
// sie live sein, Prüfung: `npm run check:legal-urls`.
//
// Stand 2026-10-27: die Seiten sind NOCH NICHT veröffentlicht (404). Die
// Werte sind die vorgesehenen Zieladressen, siehe docs/store-compliance.md.

import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";

type LegalConfig = {
  privacyPolicyUrl?: unknown;
  accountDeletionUrl?: unknown;
  supportUrl?: unknown;
};

const legal = (Constants.expoConfig?.extra?.legal ?? {}) as LegalConfig;

function httpsUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

export const PRIVACY_POLICY_URL = httpsUrl(legal.privacyPolicyUrl);
export const ACCOUNT_DELETION_URL = httpsUrl(legal.accountDeletionUrl);
export const SUPPORT_URL = httpsUrl(legal.supportUrl);

// Öffnet eine Rechtstext-Seite im In-App-Browser; fällt auf den System-
// Browser zurück. Wirft nie.
export async function openLegalUrl(url: string | null): Promise<void> {
  if (!url) return;
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    await Linking.openURL(url).catch(() => {});
  }
}
