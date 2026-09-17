import { i18next } from "@/i18n";
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
        throw new Error(i18next.t("auth:registerAdminService.missingName"));
    }

    if (!trimmedEmail) {
        throw new Error(i18next.t("auth:registerAdminService.missingEmail"));
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
        throw new Error(passwordCheck.errors[0]);
    }

    if (!trimmedCompanyName) {
        throw new Error(i18next.t("auth:registerAdminService.missingCompanyName"));
    }

    if (!companyEmail?.trim()) {
        throw new Error(i18next.t("auth:registerAdminService.missingCompanyEmail"));
    }

    if (!companyPhone?.trim()) {
        throw new Error(i18next.t("auth:registerAdminService.missingCompanyPhone"));
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
        throw new Error(toFriendlyAuthErrorMessage(error, i18next.t("auth:registerAdminService.registrationFailed")));
    }

    if (!data.user) {
        throw new Error(i18next.t("auth:registerAdminService.userCreationFailed"));
    }

    const {
        data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
        throw new Error(
            i18next.t("auth:registerAdminService.noActiveSession"),
        );
    }

    await setupCompanyForAdmin({
        companyName: trimmedCompanyName,
        contactEmail: companyEmail,
        contactPhone: companyPhone,
        adminPhone,
    });
}