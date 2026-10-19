'use client';

import { useEffect, useState } from 'react';
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
import { ApiClientError, api } from '../../api/client';
import { getValidAccessToken, refreshAccessToken } from '../../lib/auth-store';
import { useI18n } from '../../i18n';
import { SessionExpiredError, mapUsageStatus } from './usage-status';

const MIN_KEY_LENGTH = 20;

async function saveApiKey(rawKey: string): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) throw new SessionExpiredError();
  try {
    await api.putKey(token, { apiKey: rawKey });
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) {
      const retryToken = await refreshAccessToken();
      if (!retryToken) throw new SessionExpiredError();
      await api.putKey(retryToken, { apiKey: rawKey });
      return;
    }
    throw err;
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
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveShortId, setSaveShortId] = useState('');

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
    } catch (err) {
      const status = mapUsageStatus(err, {
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
            <Input
              id="limits-api-key"
              type="password"
              autoComplete="new-password"
              autoFocus
              placeholder={t.limits.keyPlaceholder}
              aria-describedby={saveError ? 'limits-key-error' : 'limits-key-hint'}
              aria-invalid={!!saveError}
              disabled={saving}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
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
            variant="primaryBrand"
            disabled={saving || apiKey.trim().length === 0}
          >
            {saving ? t.limits.saving : t.limits.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
