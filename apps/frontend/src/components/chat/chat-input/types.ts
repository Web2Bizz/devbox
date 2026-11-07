import type { ReactNode } from 'react';

export type ChatInputProps = {
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void;
  sending?: boolean;
  placeholder?: string;
  /**
   * Content pinned to the START of the composer's action row — the runner
   * (model) selector. Kit layout: `PromptInput.SlotActions` splits children
   * into `Slot.Left` / `Slot.Right`, so the picker sits inside the card next
   * to the send action instead of above the thread.
   */
  leftSlot?: ReactNode;
};
