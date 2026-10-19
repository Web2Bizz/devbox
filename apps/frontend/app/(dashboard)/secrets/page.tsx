'use client';

import { useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@web2bizz/ui/components';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { useSecrets } from '@/hooks/useSecrets';
import { useI18n } from '@/i18n';

/**
 * Route: /secrets — masked list with reveal/copy + confirm before delete.
 * TODO REAL-API: no page changes — swap inside useSecrets only.
 */
export default function SecretsPage() {
  const { t } = useI18n();
  const { secrets, loading, error, isEmpty, revealed, copiedId, reveal, hide, copy, remove, reload } =
    useSecrets();
  const [query, setQuery] = useState('');

  const filtered = secrets.filter((s) =>
    s.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {t.secrets.titleA} <span className="text-gradient-brand">{t.secrets.titleB}</span>
          </h1>
          <p className="text-muted-foreground text-sm">{t.secrets.subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
          {loading ? t.common.loading : t.common.refresh}
        </Button>
      </div>

      <div className="mb-4 grid gap-2" style={{ maxWidth: '24rem' }}>
        <Label htmlFor="secret-search">{t.secrets.searchLabel}</Label>
        <Input
          id="secret-search"
          placeholder={t.secrets.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <LoadingState rows={3} />}
      {error && !loading && <ErrorState message={error} onRetry={reload} />}
      {isEmpty && (
        <EmptyState
          title={t.secrets.emptyTitle}
          description={t.secrets.emptyDesc}
          actionLabel={t.common.refresh}
          onAction={reload}
        />
      )}

      {!loading && !error && !isEmpty && filtered.length === 0 && (
        <EmptyState title={t.secrets.noMatchesTitle} description={t.secrets.noMatchesDesc(query)} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="status-grid">
          {filtered.map((s) => {
            const value = revealed[s.id];
            const isRevealed = Boolean(value);
            return (
              <Card key={s.id} variant={isRevealed ? 'brand' : 'default'}>
                <CardHeader>
                  <CardTitle className="mono text-base">{s.name}</CardTitle>
                  <CardDescription>
                    <Badge color="info" variant="soft">
                      {s.projectId}
                    </Badge>
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <code className="mono text-muted-foreground break-all text-sm">
                    {isRevealed ? value : s.maskedPreview}
                  </code>
                  {isRevealed && (
                    <Alert>
                      <AlertTitle>{t.secrets.revealedTitle}</AlertTitle>
                      <AlertDescription>{t.secrets.revealedDesc}</AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {isRevealed ? (
                      <Button variant="outline" size="sm" onClick={() => hide(s.id)}>
                        {t.common.hide}
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => reveal(s.id)}>
                        {t.common.reveal}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => void copy(s.id)}>
                      {copiedId === s.id ? t.common.copied : t.common.copy}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm">
                          {t.common.delete}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t.secrets.deleteTitle(s.name)}</AlertDialogTitle>
                          <AlertDialogDescription>{t.secrets.deleteDesc}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove(s.id)}>
                            {t.common.confirmDelete}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
