'use client';

import { useEffect, useState } from 'react';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../i18n';
import type { AgentThinkingProps } from './types';

/**
 * Rotating "agent is working" status for the sending gap.
 * Live status first (agent [· tool]); fallback cycles t.chat.thinking.
 */
export function AgentThinking({ activeAgentName, activeToolName }: AgentThinkingProps) {
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
  return <ShimmerText>{phrases[index] ?? ''}</ShimmerText>;
}
