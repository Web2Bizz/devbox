'use client';

import { useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@web2bizz/ui/components';
import { formatApiError } from '../src/lib/format-error';
import { useI18n } from '../src/i18n';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page">
      <div className="page-inner">
        <Alert variant="destructive">
          <AlertTitle>{t.errors.pageFailed}</AlertTitle>
          <AlertDescription>{formatApiError(error)}</AlertDescription>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => reset()}>
              {t.common.tryAgain}
            </Button>
          </div>
        </Alert>
      </div>
    </main>
  );
}
