'use client';

import { useEffect, useState } from 'react';
import { ShimmerText } from '@web2bizz/ui/widgets';
import { useI18n } from '../../../i18n';

/**
 * Rotating "agent is working" status for the sending gap
 * (`sending && !streamingText`): cycles `t.chat.thinking` every ~1.6s
 * through the kit `ShimmerText` (same pattern as the streaming status).
 * Language switch (`t` identity) resets the index to the first phrase.
 */
export function AgentThinking() {
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

  return <ShimmerText>{phrases[index] ?? ''}</ShimmerText>;
}
