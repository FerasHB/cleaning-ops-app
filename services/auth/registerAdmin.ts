import { supabase } from "@/lib/supabase";
import { setupCompanyForAdmin } from "@/services/company/setupCompanyForAdmin";

type RegisterAdminInput = {
    fullName: string;
    email: string;
    password: string;
    companyName: string;
};

export async function registerAdmin({
    fullName,
    email,
    password,
    companyName,
}: RegisterAdminInput): Promise<void> {
    const trimmedFullName = fullName.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCompanyName = companyName.trim();

    if (!trimmedFullName) {
        throw new Error("Name fehlt.");
    }

    if (!trimmedEmail) {
        throw new Error("E-Mail fehlt.");
    }

    if (!password || password.length < 6) {
        throw new Error("Passwort muss mindestens 6 Zeichen haben.");
    }

    if (!trimmedCompanyName) {
        throw new Error("Firmenname fehlt.");
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
        throw new Error(error.message || "Registrierung fehlgeschlagen.");
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

    await setupCompanyForAdmin(trimmedCompanyName);
}