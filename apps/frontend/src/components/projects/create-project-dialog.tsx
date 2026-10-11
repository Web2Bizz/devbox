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
import { createProjectSchema, type CreateProjectInput } from '../../lib/project-schemas';
import { useI18n } from '../../i18n';

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
  creating?: boolean;
  trigger?: React.ReactNode;
}

function getZodErrorMessage(code: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (code) {
    case 'project_name_required':
      return t.projects.create.validation.required;
    case 'project_name_too_short':
      return t.projects.create.validation.tooShort;
    case 'project_name_too_long':
      return t.projects.create.validation.tooLong;
    case 'project_name_invalid_chars':
      return t.projects.create.validation.invalidChars;
    default:
      return t.projects.create.validation.invalidChars;
  }
}

/**
 * Popup для создания проекта — Dialog из @web2bizz/ui + react-hook-form + zod.
 * Поведение:
 * - валидация на каждом изменении (mode: onChange) и при сабмите
 * - allowed-charset: A-Za-z А-Яа-я 0-9 _ - . и пробел (см. project-schemas.ts)
 * - autoFocus на инпут при открытии
 * - сброс формы при закрытии/успехе
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
  creating = false,
  trigger,
}: CreateProjectDialogProps) {
  const { t } = useI18n();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  // sync reset on open/close — clean state each time popup opens
  useEffect(() => {
    if (open) reset({ name: '' });
  }, [open, reset]);

  const onSubmit = useCallback(
    async (data: CreateProjectInput) => {
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
          <DialogTitle>{t.projects.create.title}</DialogTitle>
          <DialogDescription>{t.projects.create.description}</DialogDescription>
        </DialogHeader>

        <form id="create-project-form" onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="project-name">{t.projects.create.nameLabel}</FieldLabel>
            <Input
              id="project-name"
              autoComplete="off"
              autoFocus
              placeholder={t.projects.create.namePlaceholder}
              aria-invalid={!!errors.name}
              aria-describedby={fieldError ? 'project-name-error' : 'project-name-hint'}
              disabled={busy}
              {...register('name')}
            />
            <FieldDescription id="project-name-hint">{t.projects.create.hint}</FieldDescription>
            {fieldError && (
              <FieldError id="project-name-error">{fieldError}</FieldError>
            )}
          </Field>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            form="create-project-form"
            variant="primaryBrand"
            disabled={busy || !isValid}
          >
            {busy ? t.projects.create.creating : t.projects.create.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
