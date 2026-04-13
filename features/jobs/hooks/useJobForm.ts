import { useState } from "react";

export type JobFormValues = {
    customerName: string;
    location: string;
    service: string;
    scheduledStart: Date | null;
    employeeId: string | null;
    notes: string;
};

export type JobFormErrors = Partial<Record<keyof JobFormValues, string>>;

const emptyValues: JobFormValues = {
    customerName: "",
    location: "",
    service: "",
    scheduledStart: null,
    employeeId: null,
    notes: "",
};

export function useJobForm(initialValues?: Partial<JobFormValues>) {
    const [values, setValues] = useState<JobFormValues>({
        ...emptyValues,
        ...initialValues,
    });

    const [errors, setErrors] = useState<JobFormErrors>({});

    const setField = <K extends keyof JobFormValues>(
        field: K,
        value: JobFormValues[K]
    ) => {
        setValues((prev) => ({ ...prev, [field]: value }));

        if (errors[field]) {
            setErrors((prev) => ({
                ...prev,
                [field]: "",
            }));
        }
    };

    const validate = () => {
        const nextErrors: JobFormErrors = {};

        if (!values.customerName.trim()) {
            nextErrors.customerName = "Bitte Kundennamen eingeben.";
        }

        if (!values.location.trim()) {
            nextErrors.location = "Bitte Ort eingeben.";
        }

        if (!values.service.trim()) {
            nextErrors.service = "Bitte Service eingeben.";
        }

        setErrors(nextErrors);
        return Object.keys(nextErrors).length === 0;
    };

    const reset = () => {
        setValues(emptyValues);
        setErrors({});
    };

    return {
        values,
        errors,
        setField,
        validate,
        reset,
        setValues,
        setErrors,
    };
}