import { Input } from "@/components/ui";
import {
    Colors,
    Radius,
    Shadows,
    Spacing,
    Typography,
} from "@/constants/theme";
import { useAuth } from "@/context/AuthContext";
import { registerAdmin } from "@/services/auth/registerAdmin";
import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
    Animated,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function RegisterScreen() {
    const { refreshProfile } = useAuth();

    const [fullName, setFullName] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");

    const [fullNameError, setFullNameError] = useState("");
    const [companyNameError, setCompanyNameError] = useState("");
    const [emailError, setEmailError] = useState("");
    const [passwordError, setPasswordError] = useState("");
    const [formError, setFormError] = useState("");

    const [loading, setLoading] = useState(false);

    const logoAnim = useRef(new Animated.Value(0)).current;
    const logoScale = useRef(new Animated.Value(0.95)).current;
    const formAnim = useRef(new Animated.Value(0)).current;
    const formSlide = useRef(new Animated.Value(20)).current;

    useEffect(() => {
        Animated.parallel([
            Animated.timing(logoAnim, {
                toValue: 1,
                duration: 500,
                useNativeDriver: true,
            }),
            Animated.spring(logoScale, {
                toValue: 1,
                useNativeDriver: true,
                speed: 12,
                bounciness: 6,
            }),
        ]).start();

        Animated.parallel([
            Animated.timing(formAnim, {
                toValue: 1,
                duration: 400,
                delay: 120,
                useNativeDriver: true,
            }),
            Animated.timing(formSlide, {
                toValue: 0,
                duration: 350,
                delay: 120,
                useNativeDriver: true,
            }),
        ]).start();
    }, [formAnim, formSlide, logoAnim, logoScale]);

    const validate = () => {
        let valid = true;

        setFullNameError("");
        setCompanyNameError("");
        setEmailError("");
        setPasswordError("");
        setFormError("");

        if (!fullName.trim()) {
            setFullNameError("Name ist erforderlich.");
            valid = false;
        }

        if (!companyName.trim()) {
            setCompanyNameError("Firmenname ist erforderlich.");
            valid = false;
        }

        if (!email.trim()) {
            setEmailError("E-Mail ist erforderlich.");
            valid = false;
        }

        if (!password) {
            setPasswordError("Passwort ist erforderlich.");
            valid = false;
        } else if (password.length < 6) {
            setPasswordError("Passwort muss mindestens 6 Zeichen haben.");
            valid = false;
        }

        return valid;
    };

    const handleRegister = async () => {
        if (!validate()) return;

        try {
            setLoading(true);

            await registerAdmin({
                fullName,
                email,
                password,
                companyName,
            });

            await refreshProfile();
            router.replace("/home");
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Registrierung fehlgeschlagen.";

            setFormError(message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
            <StatusBar barStyle="dark-content" />

            <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === "ios" ? "padding" : "height"}
            >
                <ScrollView
                    contentContainerStyle={styles.scroll}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <Animated.View
                        style={[
                            styles.brandArea,
                            { opacity: logoAnim, transform: [{ scale: logoScale }] },
                        ]}
                    >
                        <View style={styles.logoMark}>
                            <Text style={styles.logoLetter}>J</Text>
                        </View>

                        <View style={styles.brandText}>
                            <Text style={styles.brandName}>JobManager</Text>
                            <Text style={styles.brandTagline}>
                                Firmenkonto erstellen
                            </Text>
                        </View>
                    </Animated.View>

                    <Animated.View
                        style={[
                            styles.card,
                            { opacity: formAnim, transform: [{ translateY: formSlide }] },
                        ]}
                    >
                        <View style={styles.cardHeader}>
                            <Text style={styles.cardTitle}>Registrieren</Text>
                            <Text style={styles.cardSubtitle}>
                                Erstelle dein Firmenkonto als Admin
                            </Text>
                        </View>

                        {formError ? (
                            <View style={styles.errorBanner}>
                                <Text style={styles.errorBannerText}>{formError}</Text>
                            </View>
                        ) : null}

                        <View style={styles.fields}>
                            <Input
                                label="Name"
                                placeholder="Max Mustermann"
                                value={fullName}
                                onChangeText={(text: string) => {
                                    setFullName(text);
                                    setFullNameError("");
                                    setFormError("");
                                }}
                                error={fullNameError}
                                autoCapitalize="words"
                                returnKeyType="next"
                            />

                            <Input
                                label="Firmenname"
                                placeholder="Muster Reinigung GmbH"
                                value={companyName}
                                onChangeText={(text: string) => {
                                    setCompanyName(text);
                                    setCompanyNameError("");
                                    setFormError("");
                                }}
                                error={companyNameError}
                                autoCapitalize="words"
                                returnKeyType="next"
                            />

                            <Input
                                label="E-Mail"
                                placeholder="name@firma.de"
                                value={email}
                                onChangeText={(text: string) => {
                                    setEmail(text);
                                    setEmailError("");
                                    setFormError("");
                                }}
                                error={emailError}
                                autoCapitalize="none"
                                keyboardType="email-address"
                                autoComplete="email"
                                returnKeyType="next"
                            />

                            <Input
                                label="Passwort"
                                placeholder="Mindestens 6 Zeichen"
                                value={password}
                                onChangeText={(text: string) => {
                                    setPassword(text);
                                    setPasswordError("");
                                    setFormError("");
                                }}
                                error={passwordError}
                                secureTextEntry
                                autoComplete="password-new"
                                returnKeyType="done"
                                onSubmitEditing={handleRegister}
                            />
                        </View>

                        <TouchableOpacity
                            onPress={handleRegister}
                            disabled={loading}
                            activeOpacity={0.85}
                            style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
                        >
                            <Text style={styles.primaryBtnText}>
                                {loading ? "Konto wird erstellt..." : "Firma erstellen"}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            onPress={() => router.replace("/")}
                            disabled={loading}
                            activeOpacity={0.75}
                            style={styles.secondaryAction}
                        >
                            <Text style={styles.secondaryActionText}>
                                Ich habe schon ein Konto
                            </Text>
                        </TouchableOpacity>
                    </Animated.View>

                    <Animated.View style={[styles.footer, { opacity: formAnim }]}>
                        <Text style={styles.footerText}>
                            Für Unternehmer und autorisierte Firmeninhaber
                        </Text>
                    </Animated.View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: {
        flex: 1,
        backgroundColor: Colors.bg.base,
    },
    flex: {
        flex: 1,
    },
    scroll: {
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: Spacing.lg,
        paddingVertical: Spacing.xxl,
        gap: Spacing.xl,
    },

    brandArea: {
        alignItems: "center",
        gap: Spacing.md,
    },
    logoMark: {
        width: 72,
        height: 72,
        borderRadius: Radius.lg,
        backgroundColor: Colors.accent.default,
        alignItems: "center",
        justifyContent: "center",
        ...Shadows.md,
    },
    logoLetter: {
        fontSize: Typography.size.xxl,
        fontWeight: Typography.weight.extrabold,
        color: Colors.white,
    },
    brandText: {
        alignItems: "center",
        gap: Spacing.xs,
    },
    brandName: {
        fontSize: Typography.size.xl,
        fontWeight: Typography.weight.bold,
        color: Colors.text.primary,
    },
    brandTagline: {
        fontSize: Typography.size.sm,
        color: Colors.text.secondary,
    },

    card: {
        backgroundColor: Colors.bg.surface,
        borderRadius: Radius.xl,
        borderWidth: 1,
        borderColor: Colors.border.default,
        padding: Spacing.xl,
        gap: Spacing.lg,
        ...Shadows.lg,
    },
    cardHeader: {
        gap: Spacing.xs,
    },
    cardTitle: {
        fontSize: Typography.size.lg,
        fontWeight: Typography.weight.bold,
        color: Colors.text.primary,
    },
    cardSubtitle: {
        fontSize: Typography.size.sm,
        color: Colors.text.muted,
    },

    errorBanner: {
        backgroundColor: Colors.status.dangerBg,
        borderWidth: 1,
        borderColor: Colors.status.danger,
        borderRadius: Radius.md,
        paddingHorizontal: Spacing.md,
        paddingVertical: Spacing.sm,
    },
    errorBannerText: {
        fontSize: Typography.size.sm,
        color: Colors.status.danger,
        fontWeight: Typography.weight.medium,
    },

    fields: {
        gap: Spacing.md,
    },

    primaryBtn: {
        backgroundColor: Colors.accent.default,
        paddingVertical: 14,
        borderRadius: Radius.md,
        alignItems: "center",
        ...Shadows.md,
    },
    primaryBtnDisabled: {
        opacity: 0.6,
    },
    primaryBtnText: {
        fontSize: Typography.size.base,
        fontWeight: Typography.weight.semibold,
        color: Colors.white,
    },

    secondaryAction: {
        alignItems: "center",
        paddingTop: Spacing.xs,
    },
    secondaryActionText: {
        fontSize: Typography.size.sm,
        fontWeight: Typography.weight.medium,
        color: Colors.accent.text,
    },

    footer: {
        alignItems: "center",
    },
    footerText: {
        fontSize: Typography.size.xs,
        color: Colors.text.muted,
        textAlign: "center",
    },
});