import { Input } from "@/components/ui";
import { DateTimeField } from "@/components/ui/DateTimeField";
import {
    JobFormErrors,
    JobFormValues,
} from "@/features/jobs/hooks/useJobForm";
import React from "react";

type JobFormFieldsProps = {
    values: JobFormValues;
    errors: JobFormErrors;
    onChangeField: <K extends keyof JobFormValues>(
        field: K,
        value: JobFormValues[K]
    ) => void;
};

export function JobFormFields({
    values,
    errors,
    onChangeField,
}: JobFormFieldsProps) {
    return (
        <>
            <Input
                label="Kunde *"
                placeholder="z.B. Müller GmbH"
                value={values.customerName}
                onChangeText={(val) => onChangeField("customerName", val)}
                error={errors.customerName}
            />

            <Input
                label="Ort *"
                placeholder="z.B. Dortmund"
                value={values.location}
                onChangeText={(val) => onChangeField("location", val)}
                error={errors.location}
            />

            <Input
                label="Service *"
                placeholder="z.B. Wartung, Installation"
                value={values.service}
                onChangeText={(val) => onChangeField("service", val)}
                error={errors.service}
            />
            <DateTimeField
                label="Geplanter Start"
                placeholder="Datum auswählen..."
                value={values.scheduledStart}
                onChange={(val) => onChangeField("scheduledStart", val)}
            />
            <Input
                label="Notizen"
                placeholder="Interne Hinweise (optional)"
                value={values.notes}
                onChangeText={(val) => onChangeField("notes", val)}
                multiline
            />
        </>
    );
}