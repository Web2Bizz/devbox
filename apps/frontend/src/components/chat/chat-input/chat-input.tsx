'use client';

import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@web2bizz/ui/widgets';
import { Slot } from '@web2bizz/ui/components';
import { useI18n } from '../../../i18n';
import type { ChatInputProps } from './types';

/**
 * Composer on top of the kit `PromptInput` widget (0.26.3 `widgets`).
 *
 * Outward props are unchanged — the kit owns everything the local
 * implementation hand-rolled: auto-growing textarea, trim/empty guard
 * (`canSubmit`), Enter-to-submit (`submitKey="enter"`), submit↔stop swap
 * while `isStreaming` + `onCancel`, and clearing after a successful submit.
 * `disabled={sending}` keeps the old "input locked while streaming" contract
 * while `onStop` still fires through the stop button.
 */
export function ChatInput({
  onSend,
  onStop,
  sending = false,
  placeholder,
  leftSlot,
}: ChatInputProps) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t.chat.placeholder;

  return (
    <PromptInput
      aria-label={t.chat.title}
      onSubmit={(value) => {
        void onSend(value);
      }}
      onCancel={onStop}
      isStreaming={sending}
      disabled={sending}
      submitKey="enter"
      clearOnSubmit
      minHeight={44}
      maxHeight={200}
    >
      <PromptInputTextarea
        placeholder={resolvedPlaceholder}
        aria-label={resolvedPlaceholder}
      />
      <PromptInput.SlotActions>
        {leftSlot ? <Slot.Left>{leftSlot}</Slot.Left> : null}
        <PromptInputSubmit label={t.chat.send} stopLabel={t.chat.stop} />
      </PromptInput.SlotActions>
    </PromptInput>
  );
}
