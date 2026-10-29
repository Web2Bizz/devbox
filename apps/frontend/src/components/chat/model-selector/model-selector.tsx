'use client';

import { useQuery } from '@tanstack/react-query';
import type { SessionInfoModel } from '@rush-code/contracts';
import { useI18n } from '../../../i18n';
import { listSessionModels } from '../../../api/sessions-client';
import { sessionModelsQueryKey } from '../../../hooks/query-keys';

export type ModelSelectorProps = {
  projectId?: string;
  model: SessionInfoModel | null;
  onChange: (model: SessionInfoModel | null) => void;
  disabled?: boolean;
};

export function ModelSelector({ projectId, model, onChange, disabled }: ModelSelectorProps) {
  const { t } = useI18n();
  const { data: models = [], isLoading } = useQuery({
    queryKey: sessionModelsQueryKey(projectId),
    queryFn: ({ signal }) => listSessionModels(projectId ?? '', { signal }),
    enabled: !!projectId,
  });

  const value = model ? `${model.providerID}::${model.id}` : '';

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t.chat.modelLabel}>
      <select
        id="chat-model"
        className="rounded-md border px-2 py-1 text-sm"
        value={value}
        disabled={disabled || isLoading}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) {
            onChange(null);
            return;
          }
          const [providerID, id] = v.split('::');
          onChange({ providerID, id });
        }}
        aria-label={t.chat.modelLabel}
      >
        <option value="">{t.chat.modelDefault}</option>
        {models.map((m) => (
          <option key={`${m.providerID}::${m.id}`} value={`${m.providerID}::${m.id}`}>
            {m.name || m.id}
          </option>
        ))}
      </select>
      {model && (
        <span className="text-muted-foreground text-xs">
          {t.chat.modelActive}: {model.providerID}/{model.id}
        </span>
      )}
    </div>
  );
}
