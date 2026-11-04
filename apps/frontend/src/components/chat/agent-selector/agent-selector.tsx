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

/** Default agent answering chat turns (re-exported domain default). */
export { DEFAULT_AGENT_ID };

export type AgentSelectorProps = {
  agentId: string;
  onChange: (agentId: string) => void;
  disabled?: boolean;
};

/**
 * Agent picker on the kit `Select` (0.26.3 `components`) — the chat
 * replacement for the former ModelSelector.
 *
 * Sized for the composer: `size="sm"` (h-8 = `PromptInputSlot` height) and
 * `max-w-48` (the slot's width cap), so it slots into
 * `PromptInput.SlotActions > Slot.Left` without stretching the card. Data
 * stays ours (`GET /api/v1/agents` via React Query + `agentsQueryKey`).
 */
export function AgentSelector({ agentId, onChange, disabled }: AgentSelectorProps) {
  const { t } = useI18n();
  const { data: agents = [], isLoading } = useQuery({
    queryKey: agentsQueryKey,
    queryFn: ({ signal }) => listAgents({ signal }),
  });

  // The registry always carries the default agent; while it loads (or on a
  // drifted row set) the select still answers the stored id so the composer
  // never renders an empty value.
  const value = agents.some((a) => a.id === agentId) || isLoading ? agentId : DEFAULT_AGENT_ID;

  return (
    <Select value={value} disabled={disabled || isLoading} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={t.chat.agentLabel}
        className="max-w-48 border-0 bg-transparent px-1.5 text-xs shadow-none"
      >
        <SelectValue placeholder={t.chat.agentDefault} />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name || a.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
