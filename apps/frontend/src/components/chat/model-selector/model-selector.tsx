'use client';

import { useQuery } from '@tanstack/react-query';
import type { SessionInfoModel } from '@rush-code/contracts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import { listSessionModels } from '../../../api/sessions-client';
import { sessionModelsQueryKey } from '../../../hooks/query-keys';

export type ModelSelectorProps = {
  projectId?: string;
  model: SessionInfoModel | null;
  onChange: (model: SessionInfoModel | null) => void;
  disabled?: boolean;
};

/** Radix cannot carry an empty option value → sentinel for "runner default". */
const DEFAULT_VALUE = 'default';

/**
 * Runner (model) picker on the kit `Select` (0.26.3 `components`).
 *
 * Sized for the composer: `size="sm"` (h-8 = `PromptInputSlot` height) and
 * `max-w-48` (the slot's width cap), so it slots into
 * `PromptInput.SlotActions > Slot.Left` without stretching the card. Data
 * stays ours (`GET /api/sessions/models` via React Query + `sessionModelsQueryKey`).
 */
export function ModelSelector({ projectId, model, onChange, disabled }: ModelSelectorProps) {
  const { t } = useI18n();
  const { data: models = [], isLoading } = useQuery({
    queryKey: sessionModelsQueryKey(projectId),
    queryFn: ({ signal }) => listSessionModels(projectId ?? '', { signal }),
    enabled: !!projectId,
  });

  const value = model ? `${model.providerID}::${model.id}` : DEFAULT_VALUE;

  return (
    <Select
      value={value}
      disabled={disabled || isLoading}
      onValueChange={(next) => {
        if (next === DEFAULT_VALUE) {
          onChange(null);
          return;
        }
        const [providerID, id] = next.split('::');
        if (!providerID || !id) return;
        onChange({ providerID, id });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t.chat.modelLabel}
        className="max-w-48 border-0 bg-transparent px-1.5 text-xs shadow-none"
      >
        <SelectValue placeholder={t.chat.modelDefault} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>{t.chat.modelDefault}</SelectItem>
        {models.map((m) => (
          <SelectItem key={`${m.providerID}::${m.id}`} value={`${m.providerID}::${m.id}`}>
            {m.name || m.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
