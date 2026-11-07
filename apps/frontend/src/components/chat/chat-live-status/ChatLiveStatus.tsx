'use client';

import { useEffect, useState } from 'react';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';
import type { ChatLiveStatusProps } from './types';

/**
 * Rotating "agent is working" status for the sending gap
 * (`sending && !streamingText`).
 *
 * Live status first: when the turn reports an agent/tool, the line is the
 * flat `agent [· tool]` pair (no extra chrome, ShimmerText only). Reasoning
 * (`session.reasoning.*`, live-only, never durable) keeps the same line —
 * the thinking trace itself renders in `ChatThinkingRow`/`ChatStreamingRow`
 * and the timeline, never in this status. Without agent/tool data it falls
 * back to cycling `t.chat.thinking` every ~1.6s — the rotation is a
 * fallback, not the primary status. Language switch (`t` identity) resets
 * the index to the first phrase.
 */
export function ChatLiveStatus({ activeAgentName, activeToolName, reasoningActive = false }: ChatLiveStatusProps) {
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

  const live = [activeAgentName, activeToolName].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  if (live.length > 0) {
    return <ShimmerText>{live.join(' · ')}</ShimmerText>;
  }
  if (reasoningActive) {
    return <ShimmerText>{phrases[0] ?? ''}</ShimmerText>;
  }
  return <ShimmerText>{phrases[index] ?? ''}</ShimmerText>;
}
