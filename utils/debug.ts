import { supabase } from "@/lib/supabase";

export async function debugCurrentUserAccess() {
  const { data: authData, error: authError } = await supabase.auth.getUser();

  console.log("AUTH USER:", authData?.user);
  console.log("AUTH ERROR:", authError);

  const userId = authData.user?.id;

  if (!userId) {
    console.log("❌ Kein eingeloggter User gefunden.");
    return;
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, company_id, role, is_active")
    .eq("id", userId)
    .single();

  console.log("PROFILE:", profile);
  console.log("PROFILE ERROR:", profileError);

  const { data: employees, error: employeesError } = await supabase
    .from("profiles")
    .select("id, full_name, role, company_id, is_active")
    .eq("company_id", profile?.company_id)
    .eq("role", "employee")
    .eq("is_active", true);

  console.log("EMPLOYEES:", employees);
  console.log("EMPLOYEES ERROR:", employeesError);
}