import { useState } from "react";
import type { JobType } from "@/types/job";
import type { WeekdayKey } from "@/utils/recurrence";

export type JobFormValues = {
    customerName: string;
    location: string;
    service: string;
    employeeId: string | null;
    notes: string;

    // ── Terminierung ──
    jobType: JobType;
    // single: Datum + Uhrzeit in EINEM Wert (DateTimeField, mode "datetime")
    singleDateTime: Date | null;
    // recurring: nur Uhrzeit (DateTimeField, mode "time")
    startTime: Date | null;
    // recurring: ausgewählte Wochentage
    recurringDays: WeekdayKey[];
    // recurring: aktiv/inaktiv
    isActive: boolean;
};

export type JobFormErrors = Partial<Record<keyof JobFormValues, string>>;

const emptyValues: JobFormValues = {
    customerName: "",
    location: "",
    service: "",
    employeeId: null,
    notes: "",
    jobType: "single",
    singleDateTime: null,
    startTime: null,
    recurringDays: [],
    isActive: true,
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

        // ── Terminierung je nach Auftragstyp ──
        if (values.jobType === "single") {
            if (!values.singleDateTime) {
                nextErrors.singleDateTime = "Bitte Datum und Uhrzeit wählen.";
            }
        } else {
            if (values.recurringDays.length === 0) {
                nextErrors.recurringDays = "Bitte mindestens einen Wochentag wählen.";
            }
            if (!values.startTime) {
                nextErrors.startTime = "Bitte Uhrzeit wählen.";
            }
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
