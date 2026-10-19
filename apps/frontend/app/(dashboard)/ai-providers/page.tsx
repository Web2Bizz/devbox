'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Switch,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useAiProviders } from '@/hooks/useAiProviders';
import { useOpencodeEvents } from '@/hooks/useOpencodeEvents';
import { useI18n } from '@/i18n';
import type { AiProviderStatus } from '@/lib/types';

function statusColor(status: AiProviderStatus) {
  if (status === 'connected') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  return 'muted' as const;
}

function streamColor(status: string) {
  if (status === 'live') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  return 'muted' as const;
}

function streamLabel(status: string, t: ReturnType<typeof useI18n>['t']) {
  if (status === 'live') return t.opencode.live;
  if (status === 'reconnecting') return t.opencode.reconnecting;
  if (status === 'error') return t.opencode.error;
  return t.opencode.connecting;
}

/**
 * Route: /ai-providers — Card per provider + Switch toggle + configure,
 * plus the live opencode event stream (SSE through the backend
 * reverse-proxy, same @opencode-ai/sdk as the backend).
 * Providers list is live (`GET /api/opencode/config/providers` inside
 * useAiProviders); toggle/configure stay local-only until backend write
 * endpoints exist.
 */
export default function AiProvidersPage() {
  const { t } = useI18n();
  const { providers, loading, error, notice, isEmpty, toggle, configure, reload } =
    useAiProviders();
  const stream = useOpencodeEvents();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {t.aiProviders.titleA} <span className="text-gradient-brand">{t.aiProviders.titleB}</span>
          </h1>
          <p className="text-muted-foreground text-sm">{t.aiProviders.subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
          {loading ? t.common.loading : t.common.refresh}
        </Button>
      </div>

      {notice && !error && (
        <div className="mb-4">
          <Alert>
            <AlertTitle>{t.aiProviders.doneTitle}</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        </div>
      )}

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} onRetry={reload} />}
      {isEmpty && (
        <EmptyState
          title={t.aiProviders.emptyTitle}
          description={t.aiProviders.emptyDesc}
          actionLabel={t.common.refresh}
          onAction={reload}
        />
      )}

      {!loading && !error && !isEmpty && (
        <div className="status-grid">
          {providers.map((p) => (
            <Card key={p.id} variant={p.enabled ? 'brand' : 'default'}>
              <CardHeader>
                <CardTitle>{p.name}</CardTitle>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Badge color={statusColor(p.status)} variant="soft">
                  {p.status}
                </Badge>
                <Badge color="info" variant="soft">
                  {p.modelsCount} {t.aiProviders.models}
                </Badge>
                <Badge color={p.enabled ? 'success' : 'muted'} variant="soft">
                  {p.enabled ? t.aiProviders.enabled : t.aiProviders.disabled}
                </Badge>
              </CardContent>
              <CardFooter className="flex items-center gap-3">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={() => toggle(p.id)}
                  aria-label={t.aiProviders.enableLabel(p.name)}
                />
                <Button variant="outline" size="sm" onClick={() => configure(p.id)}>
                  {t.aiProviders.configure}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>{t.opencode.streamTitle}</CardTitle>
                <CardDescription>{t.opencode.streamSubtitle}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge color={streamColor(stream.status)} variant="soft">
                  {streamLabel(stream.status, t)}
                </Badge>
                <Button variant="outline" size="sm" onClick={stream.reconnect}>
                  {t.opencode.reconnect}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {stream.error && (
              <div className="mb-3">
                <ErrorState message={stream.error} onRetry={stream.reconnect} />
              </div>
            )}
            {stream.events.length === 0 ? (
              <EmptyState title={t.opencode.eventsEmpty} description="" actionLabel={t.opencode.reconnect} onAction={stream.reconnect} />
            ) : (
              <ul className="flex flex-col gap-2">
                {stream.events.slice(-10).reverse().map((ev, i) => (
                  <li key={`${(ev as { type?: string }).type ?? 'event'}-${i}`} className="text-sm">
                    <Badge color="info" variant="soft">
                      {(ev as { type?: string }).type ?? 'event'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
