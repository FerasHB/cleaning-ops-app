import { supabase } from "@/lib/supabase";
import { setupCompanyForAdmin } from "@/services/company/setupCompanyForAdmin";
import { toFriendlyAuthErrorMessage } from "@/utils/authErrorMessages";
import { normalizeEmail } from "@/utils/email";
import { validatePassword } from "@/utils/passwordValidation";

type RegisterAdminInput = {
    fullName: string;
    email: string;
    password: string;
    companyName: string;
    /** Firmen-Kontakt-E-Mail (Pflicht in der Registrierungs-UX). */
    companyEmail: string;
    /** Firmen-Rufnummer, roh (wird in setupCompanyForAdmin normalisiert). */
    companyPhone: string;
    /** Persönliche Rufnummer des Admins (optional). */
    adminPhone?: string;
};

export async function registerAdmin({
    fullName,
    email,
    password,
    companyName,
    companyEmail,
    companyPhone,
    adminPhone,
}: RegisterAdminInput): Promise<void> {
    const trimmedFullName = fullName.trim();
    const trimmedEmail = normalizeEmail(email);
    const trimmedCompanyName = companyName.trim();

    if (!trimmedFullName) {
        throw new Error("Name fehlt.");
    }

    if (!trimmedEmail) {
        throw new Error("E-Mail fehlt.");
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
        throw new Error(passwordCheck.errors[0]);
    }

    if (!trimmedCompanyName) {
        throw new Error("Firmenname fehlt.");
    }

    if (!companyEmail?.trim()) {
        throw new Error("Firmen-E-Mail fehlt.");
    }

    if (!companyPhone?.trim()) {
        throw new Error("Firmen-Telefon fehlt.");
    }

    const { data, error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
            data: {
                full_name: trimmedFullName,
            },
        },
    });

    if (error) {
        throw new Error(toFriendlyAuthErrorMessage(error, "Registrierung fehlgeschlagen."));
    }

    if (!data.user) {
        throw new Error("User konnte nicht erstellt werden.");
    }

    const {
        data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
        throw new Error(
            "Registrierung erfolgreich, aber keine aktive Session. Prüfe Email Confirmation in Supabase.",
        );
    }

    await setupCompanyForAdmin({
        companyName: trimmedCompanyName,
        contactEmail: companyEmail,
        contactPhone: companyPhone,
        adminPhone,
    });
}