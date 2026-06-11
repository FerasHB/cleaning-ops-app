// features/jobs/components/JobPhotos.tsx
// Foto-Sektion für einen Job: Anzeige + Upload (MVP, online-only).
// Kein Löschen — Fotos sind Nachweise.
// ImagePicker-Logik liegt hier; Business-Logik (Upload, Laden) im Hook und Service.

import { Button, Card, ErrorBanner } from "@/components/ui";
import type { AppTheme } from "@/constants/theme";
import { useJobPhotos } from "@/features/jobs/hooks/useJobPhotos";
import { useAppTheme } from "@/hooks/useAppTheme";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

// ─────────────────────────────────────────────
// Konstanten
// ─────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const SUCCESS_DISPLAY_MS = 3000;
const THUMBNAIL_SIZE = 88;

// ─────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────

type JobPhotosProps = {
  jobId: string;
  /** Darf der aktuelle Benutzer Fotos hochladen? (Admin immer; Employee nur wenn zugewiesen) */
  canUpload: boolean;
  /** Netzwerkstatus — bei false ist Upload-Button deaktiviert */
  isOnline: boolean;
};

// ─────────────────────────────────────────────
// Komponente
// ─────────────────────────────────────────────

export function JobPhotos({ jobId, canUpload, isOnline }: JobPhotosProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const { photos, loading, uploading, error, offline, upload } = useJobPhotos(
    jobId,
    isOnline,
  );

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successVisible, setSuccessVisible] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Success-Banner nach festem Zeitraum automatisch ausblenden
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  // Vollbild-Vorschau: signedUrl des angetippten Fotos (null = geschlossen)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Upload-Button ist nur aktiv wenn: canUpload, online und kein Upload läuft
  const uploadEnabled = canUpload && isOnline && !uploading;

  // ── Quelle wählen: Kamera oder Galerie ──
  function handleAddPhoto() {
    setUploadError(null);
    Alert.alert(
      "Foto hinzufügen",
      "Wähle eine Quelle:",
      [
        { text: "Foto aufnehmen", onPress: pickFromCamera },
        { text: "Aus Galerie wählen", onPress: pickFromLibrary },
        { text: "Abbrechen", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  // ── Kamera-Flow ──
  async function pickFromCamera() {
    setUploadError(null);

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Kamera-Zugriff verweigert",
        "Damit du ein Foto aufnehmen kannst, benötigt die App Zugriff auf die Kamera. Bitte erteile die Berechtigung in den Einstellungen.",
        [{ text: "OK" }],
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: "images",
      quality: 0.7,
      allowsEditing: false,
      exif: false,
    });

    await processPickerResult(result);
  }

  // ── Galerie-Flow ──
  async function pickFromLibrary() {
    setUploadError(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Zugriff verweigert",
        "Damit du Fotos hochladen kannst, benötigt die App Zugriff auf deine Fotomediathek. Bitte erteile die Berechtigung in den Einstellungen.",
        [{ text: "OK" }],
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      quality: 0.7,
      allowsEditing: false,
      allowsMultipleSelection: false,
      exif: false,
    });

    await processPickerResult(result);
  }

  // ── Gemeinsame Verarbeitung: Validierung + Upload (Kamera und Galerie) ──
  async function processPickerResult(result: ImagePicker.ImagePickerResult) {
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    const mimeType = asset.mimeType ?? "image/jpeg";
    const fileSize = asset.fileSize ?? 0;
    const fileName =
      asset.fileName ??
      `foto_${Date.now()}.${mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"}`;

    // HEIC und andere nicht erlaubte Formate clientseitig abfangen,
    // bevor der Service angesprochen wird.
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      setUploadError(
        "Dieses Dateiformat wird nicht unterstützt. Bitte wähle ein Foto im Format JPEG, PNG oder WebP.",
      );
      return;
    }

    // Dateigröße prüfen (nur wenn bekannt, Fallback auf Server-Limit)
    if (fileSize > 0 && fileSize > MAX_FILE_SIZE_BYTES) {
      const actualMb = (fileSize / (1024 * 1024)).toFixed(1);
      setUploadError(
        `Das Foto ist zu groß (${actualMb} MB). Maximal erlaubt sind 10 MB.`,
      );
      return;
    }

    try {
      await upload({ uri: asset.uri, fileName, mimeType, fileSize });
      // Erfolgs-Feedback
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      setSuccessVisible(true);
      successTimerRef.current = setTimeout(
        () => setSuccessVisible(false),
        SUCCESS_DISPLAY_MS,
      );
    } catch (err: unknown) {
      // Fehler wurde im Hook bereits in error-State gesetzt;
      // hier als lokalen uploadError spiegeln für direktes Feedback.
      setUploadError(
        err instanceof Error ? err.message : "Upload fehlgeschlagen.",
      );
    }
  }

  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────

  return (
    <Card padding={theme.spacing.lg} style={styles.card}>

      {/* ── Header: Label + Upload-Button ── */}
      <View style={styles.headerRow}>
        <View style={styles.labelRow}>
          <Ionicons name="images-outline" size={12} color={theme.colors.primary} />
          <Text style={styles.label}>FOTOS</Text>
          {photos.length > 0 && (
            <Text style={styles.count}>({photos.length})</Text>
          )}
        </View>

        {canUpload && (
          <Button
            label={uploading ? "Wird hochgeladen …" : "Foto hinzufügen"}
            icon={uploading ? undefined : "camera-outline"}
            variant="secondary"
            fullWidth={false}
            disabled={!uploadEnabled}
            loading={uploading}
            onPress={handleAddPhoto}
            style={styles.uploadButton}
          />
        )}
      </View>

      {/* ── Offline-Hinweis (nur wenn Upload prinzipiell erlaubt wäre) ── */}
      {canUpload && !isOnline && (
        <View style={styles.offlineHint}>
          <Ionicons
            name="cloud-offline-outline"
            size={14}
            color={theme.colors.onSurfaceVariant}
          />
          <Text style={styles.offlineText}>
            Foto-Upload nur mit Internetverbindung möglich.
          </Text>
        </View>
      )}

      {/* ── Fehler-Banner (Lade- oder Upload-Fehler) ── */}
      {(uploadError ?? error) && (
        <ErrorBanner
          message={(uploadError ?? error) as string}
          onDismiss={() => {
            setUploadError(null);
          }}
        />
      )}

      {/* ── Erfolgs-Banner ── */}
      {successVisible && (
        <View style={styles.successBanner}>
          <Ionicons
            name="checkmark-circle-outline"
            size={16}
            color={theme.colors.statusCompleted}
          />
          <Text style={styles.successText}>Foto erfolgreich hochgeladen.</Text>
        </View>
      )}

      {/* ── Lade-/Leer-/Listen-Zustand ── */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : photos.length === 0 ? (
        // Offline ohne geladene Fotos: ruhige Meldung statt rotem Fehler.
        <Text style={styles.emptyText}>
          {offline
            ? "Fotos sind offline nicht verfügbar."
            : "Noch keine Fotos vorhanden."}
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scrollView}
          contentContainerStyle={styles.photoList}
        >
          {photos.map((photo) => (
            <View key={photo.id} style={styles.thumbnailWrap}>
              {photo.signedUrl ? (
                // Antippen öffnet die Vollbild-Vorschau (gleiche Signed URL)
                <Pressable
                  onPress={() => setPreviewUrl(photo.signedUrl)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel="Foto groß anzeigen"
                >
                  <Image
                    source={{ uri: photo.signedUrl }}
                    style={styles.thumbnail}
                    contentFit="cover"
                    transition={150}
                  />
                </Pressable>
              ) : (
                // Signed URL fehlt (z. B. Storage-Fehler) → Platzhalter
                <View style={[styles.thumbnail, styles.thumbnailPlaceholder]}>
                  <Ionicons
                    name="image-outline"
                    size={24}
                    color={theme.colors.outline}
                  />
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {/* ── Vollbild-Vorschau (Modal) ── */}
      <Modal
        visible={previewUrl !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewUrl(null)}
        statusBarTranslucent
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            style={styles.previewCloseButton}
            onPress={() => setPreviewUrl(null)}
            accessibilityRole="button"
            accessibilityLabel="Vorschau schließen"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>

          {previewUrl ? (
            <Image
              source={{ uri: previewUrl }}
              style={styles.previewImage}
              contentFit="contain"
              transition={150}
            />
          ) : null}
        </View>
      </Modal>
    </Card>
  );
}

// ─────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: theme.spacing.md,
    },

    // Header
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.sm,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    label: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.semibold,
      fontWeight: theme.typography.weight.semibold,
      color: theme.colors.outline,
      letterSpacing: theme.typography.letterSpacing.wider,
    },
    count: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.outline,
    },
    uploadButton: {
      paddingVertical: 7,
      paddingHorizontal: theme.spacing.md,
      minHeight: 0,
    },

    // Offline
    offlineHint: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
    },
    offlineText: {
      fontSize: theme.typography.size.xs,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
      flexShrink: 1,
    },

    // Erfolg
    successBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.statusCompletedBg,
      borderWidth: 1,
      borderColor: theme.colors.statusCompletedBorder,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 8,
    },
    successText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.medium,
      fontWeight: theme.typography.weight.medium,
      color: theme.colors.statusCompleted,
    },

    // Zustände
    loadingWrap: {
      paddingVertical: theme.spacing.md,
      alignItems: "center",
    },
    emptyText: {
      fontSize: theme.typography.size.sm,
      fontFamily: theme.typography.family.regular,
      color: theme.colors.onSurfaceVariant,
    },

    // Foto-Liste
    scrollView: {
      marginHorizontal: -theme.spacing.xs,
    },
    photoList: {
      paddingHorizontal: theme.spacing.xs,
      gap: theme.spacing.sm,
      flexDirection: "row",
    },
    thumbnailWrap: {
      borderRadius: theme.radius.md,
      overflow: "hidden",
      // Android: Schatten funktioniert nur wenn overflow nicht hidden — akzeptabel
      ...Platform.select({
        ios: theme.shadows.sm,
        android: {},
      }),
    },
    thumbnail: {
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      borderRadius: theme.radius.md,
    },
    thumbnailPlaceholder: {
      backgroundColor: theme.colors.surfaceContainerHigh,
      alignItems: "center",
      justifyContent: "center",
    },

    // Vollbild-Vorschau (Modal) — bewusst feste dunkle Farben, unabhängig vom Theme
    previewBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.92)",
      alignItems: "center",
      justifyContent: "center",
    },
    previewImage: {
      width: "100%",
      height: "100%",
    },
    previewCloseButton: {
      position: "absolute",
      top: Platform.OS === "ios" ? 56 : 24,
      right: 20,
      zIndex: 2,
      width: 44,
      height: 44,
      borderRadius: theme.radius.full,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
