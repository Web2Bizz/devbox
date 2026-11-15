'use client';

import { useEffect, useState } from 'react';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatLiveStatusProps } from './types';

/**
 * Rotating "mode is working" status for the sending gap (`sending`).
 *
 * Live status first: when the turn reports a mode, the line is the flat
 * mode name (no extra chrome, ShimmerText only). The active tool (the tool
 * of the active mode) is NOT
 * joined here anymore — it renders as its own `ChatToolRow` line in the flat
 * thread chronology, so `mode · tool` never appears as one fused status.
 * Reasoning (`session.reasoning.*`, live sidecar in entries, never durable
 * text) keeps the same line — the thinking trace itself renders in
 * `ChatThinkingRow` and as `reasoning` chain rows, never in this status.
 * Without mode data it falls back to cycling `t.chat.thinking`
 * every ~1.6s — the rotation is a fallback, not the primary status. Language
 * switch (`t` identity) resets the index to the first phrase.
 */
export function ChatLiveStatus({ activeModeName, reasoningActive = false }: ChatLiveStatusProps) {
  const { t } = useI18n();
  const phrases = t.chat.thinking;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [t]);

  useEffect(() => {
    if (phrases.length < 2) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % phrases.length);
    }, 1600);
    return () => clearInterval(id);
  }, [phrases.length]);

  if (typeof activeModeName === 'string' && activeModeName.length > 0) {
    return <ShimmerText>{activeModeName}</ShimmerText>;
  }
  if (reasoningActive) {
    return <ShimmerText>{phrases[0] ?? ''}</ShimmerText>;
  }
  return <ShimmerText>{phrases[index] ?? ''}</ShimmerText>;
}
