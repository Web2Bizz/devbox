'use client';

import { useState } from 'react';
import type { SessionInfoModel } from '@rush-code/contracts';
import { useI18n } from '../../../i18n';
import { useAiProviders } from '../../../hooks/useAiProviders';

export type ModelSelectorProps = {
  /** Rush Code project uuid — scopes the domain provider inventory. */
  projectId?: string;
  /** Currently picked model (null = runner default). */
  model: SessionInfoModel | null;
  onChange: (model: SessionInfoModel | null) => void;
  disabled?: boolean;
};

/**
 * Provider→model picker for the chat (domain `GET /api/sessions/providers`
 * via `useAiProviders` — the REQUIRED artifact Provider.Info subset, no
 * credential-bearing members ever reach the browser).
 *
 * The provider inventory carries no model list upstream (Provider.Info has
 * no models member), so the model id is typed explicitly: provider select
 * + model id input. Apply pins `{providerID, id}` for the next prompt
 * (lazy session create + prompt body); Clear falls back to the runner
 * default. Pure presentational state lives here; the effective model lives
 * in `useChat` (survives reload).
 */
export function ModelSelector({ projectId, model, onChange, disabled }: ModelSelectorProps) {
  const { t } = useI18n();
  const { providers, loading } = useAiProviders(projectId);
  const [providerID, setProviderID] = useState(model?.providerID ?? '');
  const [modelId, setModelId] = useState(model?.id ?? '');

  const apply = () => {
    const pid = providerID.trim();
    const mid = modelId.trim();
    if (!pid || !mid) return;
    onChange({ providerID: pid, id: mid });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t.chat.modelLabel}>
      <label className="text-muted-foreground text-xs" htmlFor="chat-model-provider">
        {t.chat.modelProvider}
      </label>
      <select
        id="chat-model-provider"
        className="rounded-md border px-2 py-1 text-sm"
        value={providerID}
        disabled={disabled || loading}
        onChange={(e) => setProviderID(e.target.value)}
        aria-label={t.chat.modelProvider}
      >
        <option value="">{t.chat.modelDefault}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.id}
          </option>
        ))}
      </select>
      <input
        className="rounded-md border px-2 py-1 text-sm"
        value={modelId}
        disabled={disabled}
        onChange={(e) => setModelId(e.target.value)}
        placeholder={t.chat.modelIdPlaceholder}
        aria-label={t.chat.modelLabel}
      />
      <button
        type="button"
        className="rounded-md border px-2 py-1 text-sm"
        disabled={disabled || !providerID.trim() || !modelId.trim()}
        onClick={apply}
      >
        {t.chat.modelLabel}
      </button>
      {model && (
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-sm"
          disabled={disabled}
          onClick={() => {
            setProviderID('');
            setModelId('');
            onChange(null);
          }}
          aria-label={t.chat.modelClear}
        >
          {t.chat.modelClear}
        </button>
      )}
      {model && (
        <span className="text-muted-foreground text-xs">
          {t.chat.modelActive}: {model.providerID}/{model.id}
        </span>
      )}
    </div>
  );
}
