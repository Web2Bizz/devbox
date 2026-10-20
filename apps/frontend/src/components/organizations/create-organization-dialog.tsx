'use client';

import { useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
} from '@web2bizz/ui/components';
import { createOrganizationSchema, type CreateOrganizationInput } from '../../lib/organization-schemas';
import { useI18n } from '../../i18n';

export type CreateOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
  creating?: boolean;
  trigger?: React.ReactNode;
};

function getZodErrorMessage(code: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (code) {
    case 'org_name_required':
      return t.orgs.create.validation.required;
    case 'org_name_too_short':
      return t.orgs.create.validation.tooShort;
    case 'org_name_too_long':
      return t.orgs.create.validation.tooLong;
    default:
      return t.orgs.create.validation.required;
  }
}

/**
 * Popup для создания организации — Dialog из @web2bizz/ui + react-hook-form + zod.
 * Поведение (эталон: CreateProjectDialog):
 * - валидация на каждом изменении (mode: onChange) и при сабмите
 * - autoFocus на инпут при открытии, сброс формы при закрытии/успехе
 */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreate,
  creating = false,
  trigger,
}: CreateOrganizationDialogProps) {
  const { t } = useI18n();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  useEffect(() => {
    if (open) reset({ name: '' });
  }, [open, reset]);

  const onSubmit = useCallback(
    async (data: CreateOrganizationInput) => {
      await onCreate(data.name.trim());
      reset({ name: '' });
      onOpenChange(false);
    },
    [onCreate, onOpenChange, reset],
  );

  const fieldError = errors.name?.message
    ? getZodErrorMessage(String(errors.name.message), t)
    : null;

  const busy = creating || isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t.orgs.create.title}</DialogTitle>
          <DialogDescription>{t.orgs.create.description}</DialogDescription>
        </DialogHeader>

        <form id="create-org-form" onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="org-name">{t.orgs.create.nameLabel}</FieldLabel>
            <Input
              id="org-name"
              autoComplete="off"
              autoFocus
              placeholder={t.orgs.create.namePlaceholder}
              aria-invalid={!!errors.name}
              aria-describedby={fieldError ? 'org-name-error' : 'org-name-hint'}
              disabled={busy}
              {...register('name')}
            />
            <FieldDescription id="org-name-hint">{t.orgs.create.hint}</FieldDescription>
            {fieldError && <FieldError id="org-name-error">{fieldError}</FieldError>}
          </Field>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            form="create-org-form"
            variant="primaryBrand"
            disabled={busy || !isValid}
          >
            {busy ? t.orgs.create.creating : t.orgs.create.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
