import { supabase } from "@/lib/supabase";

type CreateEmployeeInput = {
  fullName: string;
  email: string;
  password: string;
};

export async function createEmployee(input: CreateEmployeeInput) {

  const { data, error } = await supabase.functions.invoke("create-employee", {

    body: {

      fullName: input.fullName,

      email: input.email,

      password: input.password,

    },

  });

  

  if (error) {

    throw new Error(error.message);

  }

  if (data?.error) {

    throw new Error(data.error);

  }

  return data;

}
