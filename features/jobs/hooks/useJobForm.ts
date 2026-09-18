import { useMemo, useRef, useState } from "react";
import type { JobType } from "@/types/job";
import type { WeekdayKey } from "@/utils/recurrence";
import { i18next } from "@/i18n";

export type JobFormValues = {
    customerName: string;
    location: string;
    service: string;
    // Zuweisungsmenge (Phase 6 Schreibpfad). Leer = niemandem zugewiesen.
    employeeIds: string[];
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
    // recurring: Gültigkeitszeitraum (Startdatum Pflicht, Enddatum optional)
    recurrenceStartDate: Date | null;
    recurrenceEndDate:   Date | null;
    // Geplante Dauer in Minuten, optional (Phase 3 Planned Duration).
    // Als Rohtext gehalten wie andere Input-Felder; nur Ziffern (siehe
    // JobFormFields onChangeText), leer = keine Dauer geplant.
    durationMinutes: string;
};

export type JobFormErrors = Partial<Record<keyof JobFormValues, string>>;

const emptyValues: JobFormValues = {
    customerName: "",
    location: "",
    service: "",
    employeeIds: [],
    notes: "",
    jobType: "single",
    singleDateTime: null,
    startTime: null,
    recurringDays: [],
    isActive: true,
    recurrenceStartDate: null,
    recurrenceEndDate: null,
    durationMinutes: "",
};

export function useJobForm(initialValues?: Partial<JobFormValues>) {
    const [values, setValues] = useState<JobFormValues>({
        ...emptyValues,
        ...initialValues,
    });

    const [errors, setErrors] = useState<JobFormErrors>({});

    // Ausgangsstand beim Mount — Basis für isDirty (Warnung vor dem Verlassen
    // mit ungespeicherten Änderungen).
    //
    // NUR für das ERSTELLEN-Formular gedacht: der Bearbeiten-Screen befüllt die
    // Werte nach dem Laden per setValues und hätte hier eine veraltete Basis.
    // Er hat dafür eine eigene, job-bezogene hasChanges-Berechnung, die
    // zusätzlich Datums-/Zeit-Normalisierung berücksichtigt.
    const baselineRef = useRef<JobFormValues>({
        ...emptyValues,
        ...initialValues,
    });

    const isDirty = useMemo(() => {
        const base = baselineRef.current;
        return (
            values.customerName !== base.customerName ||
            values.location !== base.location ||
            values.service !== base.service ||
            values.notes !== base.notes ||
            values.jobType !== base.jobType ||
            values.isActive !== base.isActive ||
            values.employeeIds.length !== base.employeeIds.length ||
            values.employeeIds.some((id) => !base.employeeIds.includes(id)) ||
            values.recurringDays.length !== base.recurringDays.length ||
            values.recurringDays.some((d) => !base.recurringDays.includes(d)) ||
            values.singleDateTime?.getTime() !== base.singleDateTime?.getTime() ||
            values.startTime?.getTime() !== base.startTime?.getTime() ||
            values.recurrenceStartDate?.getTime() !==
                base.recurrenceStartDate?.getTime() ||
            values.recurrenceEndDate?.getTime() !==
                base.recurrenceEndDate?.getTime() ||
            values.durationMinutes !== base.durationMinutes
        );
    }, [values]);

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
            nextErrors.customerName = i18next.t("admin:jobForm.validation.customerRequired");
        }

        if (!values.location.trim()) {
            nextErrors.location = i18next.t("admin:jobForm.validation.addressRequired");
        }

        if (!values.service.trim()) {
            nextErrors.service = i18next.t("admin:jobForm.validation.serviceRequired");
        }

        // ── Terminierung je nach Auftragstyp ──
        if (values.jobType === "single") {
            if (!values.singleDateTime) {
                nextErrors.singleDateTime = i18next.t("admin:jobForm.validation.selectDateTime");
            }
        } else {
            if (values.recurringDays.length === 0) {
                nextErrors.recurringDays = i18next.t("admin:jobForm.validation.selectWeekday");
            }
            if (!values.startTime) {
                nextErrors.startTime = i18next.t("admin:jobForm.validation.selectTime");
            }
            if (!values.recurrenceStartDate) {
                nextErrors.recurrenceStartDate = i18next.t("admin:jobForm.validation.selectStartDate");
            }
            if (
                values.recurrenceStartDate &&
                values.recurrenceEndDate &&
                values.recurrenceEndDate < values.recurrenceStartDate
            ) {
                nextErrors.recurrenceEndDate = i18next.t("admin:jobForm.validation.endBeforeStart");
            }
        }

        setErrors(nextErrors);
        return Object.keys(nextErrors).length === 0;
    };

    const reset = () => {
        setValues(emptyValues);
        setErrors({});
        // Basis mitziehen, sonst gilt das frisch geleerte Formular als geändert.
        baselineRef.current = emptyValues;
    };

    return {
        values,
        errors,
        isDirty,
        setField,
        validate,
        reset,
        setValues,
        setErrors,
    };
}
