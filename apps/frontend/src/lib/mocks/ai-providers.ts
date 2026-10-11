import type { AiProvider } from '../types';

/**
 * MOCK AI provider fixtures — keys are placeholders only.
 * Offline fixture only (not wired): useAiProviders reads the live list from
 * GET /api/opencode/config/providers via the backend reverse-proxy; toggle/
 * configure there stay local-only until backend write endpoints exist.
 * All exports keep the MOCK_ prefix by convention.
 */
export const MOCK_AI_PROVIDERS: AiProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models via API key (mock, key not stored).',
    enabled: true,
    status: 'connected',
    modelsCount: 12,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models — configure an API key to connect.',
    enabled: false,
    status: 'disconnected',
    modelsCount: 8,
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    description: 'Local runner — last sync failed in this mock.',
    enabled: true,
    status: 'error',
    modelsCount: 5,
  },
];

/** Placeholder key shapes — never real credentials. */
export const MOCK_AI_PROVIDER_KEYS: Record<string, string> = {
  openai: 'MOCK_sk_openai_do_not_use',
  anthropic: 'MOCK_sk_anthropic_do_not_use',
  ollama: 'MOCK_localhost:11434',
};
