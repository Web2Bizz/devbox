'use client';

import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
} from '@web2bizz/ui/components';
import { ApiClientError, api } from '../api/client';
import { getValidAccessToken, refreshAccessToken } from '../lib/auth-store';
import { useI18n } from '../i18n';
import { SessionExpiredError, mapUsageStatus } from './usage-status';

const MIN_KEY_LENGTH = 20;

type ApiKeyInputProps = ComponentProps<typeof Input>;

async function upsertApiKey(token: string, rawKey: string): Promise<void> {
  const list = await api.listVaultSecrets(token);
  const current = list.secrets.find((secret) => secret.provider === 'opencode');
  if (current) {
    await api.updateVaultSecret(token, current.id, { apiKey: rawKey });
    return;
  }
  await api.createVaultSecret(token, { provider: 'opencode', apiKey: rawKey });
}

async function saveApiKey(rawKey: string): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  try {
    await upsertApiKey(token, rawKey);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      await upsertApiKey(retryToken, rawKey);
      return;
    }
    throw error;
  }
}

export function ApiKeyDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveShortId, setSaveShortId] = useState<string>('');

  useEffect(() => {
    if (open) {
      setApiKey('');
      setSaveError(null);
      setSaveShortId('');
      setSaving(false);
    }
  }, [open]);

  const fail = (message: string, shortId = '') => {
    setSaveError(message);
    setSaveShortId(shortId);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      fail(t.limits.required);
      return;
    }
    if (trimmed.length < MIN_KEY_LENGTH) {
      fail(t.limits.tooShort);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveShortId('');
    try {
      await saveApiKey(trimmed);
      setApiKey('');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      const status = mapUsageStatus(error, {
        sessionExpired: t.errors.sessionExpired,
        unexpected: t.errors.unexpected,
      });
      if (status.kind === 'session-expired' || status.kind === 'failed') {
        fail(status.message, status.kind === 'failed' ? status.shortId : '');
      } else {
        fail(t.errors.unexpected);
      }
    } finally {
      setSaving(false);
    }
  };

  const apiKeyInputProps: ApiKeyInputProps = {
    id: 'limits-api-key',
    type: 'password',
    autoComplete: 'new-password',
    autoFocus: true,
    placeholder: t.limits.keyPlaceholder,
    'aria-describedby': saveError ? 'limits-key-error' : 'limits-key-hint',
    'aria-invalid': !!saveError,
    disabled: saving,
    value: apiKey,
    onChange: (e) => setApiKey(e.target.value),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t.limits.dialogTitle}</DialogTitle>
          <DialogDescription>{t.limits.dialogDesc}</DialogDescription>
        </DialogHeader>

        <form id="limits-key-form" onSubmit={submit} className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="limits-api-key">{t.limits.keyLabel}</FieldLabel>
            <Input {...apiKeyInputProps} />
            <FieldDescription id="limits-key-hint">{t.limits.keyHint}</FieldDescription>
            {saveError && (
              <FieldError id="limits-key-error">
                {saveError}
                {saveShortId && ` (${t.errors.diagnosticId}: ${saveShortId})`}
              </FieldError>
            )}
          </Field>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            form="limits-key-form"
            variant="default"
            disabled={saving || apiKey.trim().length === 0}
          >
            {saving ? t.limits.saving : t.limits.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
