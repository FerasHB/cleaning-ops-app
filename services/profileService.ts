import { supabase } from "@/lib/supabase";

export type AppRole = "admin" | "employee";

export type AuthProfile = {
  id: string;
  full_name: string;
  company_id: string | null;
  role: AppRole;
  is_active: boolean;
};

export async function getProfileByUserId(
  userId: string,
): Promise<AuthProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, company_id, role, is_active")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("Failed to load profile:", error);
    return null;
  }

  return data as AuthProfile;
}