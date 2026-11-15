'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import { DEFAULT_AGENT_ID, listAgents } from '../../../api/sessions-client';
import { agentsQueryKey } from '../../../hooks/query-keys';
import type { ModeSelectorProps } from './types';

/** Default mode answering chat turns (re-exported domain default). */
export { DEFAULT_AGENT_ID };

/**
 * Mode picker on the kit `Select` (0.26.3 `components`) — the chat
 * replacement for the former ModelSelector. Ask/Auto are work modes,
 * not agents.
 *
 * Sized for the composer: `size="sm"` (h-8 = `PromptInputSlot` height) and
 * `max-w-48` (the slot's width cap), so it slots into
 * `PromptInput.SlotActions > Slot.Left` without stretching the card. Data
 * stays ours (`GET /api/v1/agents` via React Query + `agentsQueryKey`).
 */
export function ModeSelector({ modeId, onChange, disabled }: ModeSelectorProps) {
  const { t } = useI18n();
  const { data: modes = [], isLoading } = useQuery({
    queryKey: agentsQueryKey,
    queryFn: ({ signal }) => listAgents({ signal }),
  });

  // The registry always carries the default mode; while it loads (or on a
  // drifted row set) the select still answers the stored id so the composer
  // never renders an empty value.
  const value = modes.some((a) => a.id === modeId) || isLoading ? modeId : DEFAULT_AGENT_ID;

  return (
    <Select value={value} disabled={disabled || isLoading} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={t.chat.modeLabel}
        className="max-w-48 border-0 bg-transparent px-1.5 text-xs shadow-none"
      >
        <SelectValue placeholder={t.chat.modeDefault} />
      </SelectTrigger>
      <SelectContent>
        {modes.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name || a.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
