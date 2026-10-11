'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@web2bizz/ui/components';
import { useI18n } from '../../i18n';

export interface ChatInputProps {
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void;
  sending?: boolean;
  placeholder?: string;
}

/**
 * Kit composer (`components` InputGroup): outward `ChatInputProps`
 * unchanged — trim/empty-guard, Enter→send+clear, `sending`→disabled+Stop,
 * t.chat.* labels + aria. Single-line InputGroupInput; Shift+Enter no-op.
 */
export function ChatInput({ onSend, onStop, sending = false, placeholder }: ChatInputProps) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const canSend = !sending && trimmed.length > 0;
  const resolvedPlaceholder = placeholder ?? t.chat.placeholder;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    void onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!canSend) return;
      void onSend(trimmed);
      setValue('');
    }
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2" aria-label={t.chat.title}>
      <InputGroup className="flex-1">
        <InputGroupInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={resolvedPlaceholder}
          disabled={sending}
          aria-label={resolvedPlaceholder}
          aria-busy={sending}
        />
        <InputGroupAddon align="inline-end">
          {sending ? (
            <InputGroupButton
              type="button"
              variant="outline"
              size="sm"
              onClick={onStop}
              aria-label={t.chat.stop}
            >
              {t.chat.stop}
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="sm"
              disabled={!canSend}
              aria-label={t.chat.send}
            >
              {t.chat.send}
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
