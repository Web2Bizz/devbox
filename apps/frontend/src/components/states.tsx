'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
} from '@web2bizz/ui/components';
import { useI18n } from '../i18n';

/** Grid card skeleton — matches status-grid Card layout. */
export function ProjectCardSkeleton() {
  return (
    <Card>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </CardContent>
      <CardFooter>
        <Skeleton className="h-3 w-32" />
      </CardFooter>
    </Card>
  );
}

/** Header skeleton for the detail page (title + tabs). */
export function ProjectDetailSkeleton() {
  const { t } = useI18n();
  return (
    <div aria-busy="true" aria-label={t.common.loadingPage} className="grid gap-4">
      <div className="grid gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-4 w-3/4 max-w-md" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
    </div>
  );
}

/** Grid skeleton — matches status-grid. */
export function LoadingState({ rows = 3 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="status-grid" aria-busy="true" aria-label={t.common.loadingPage}>
      {Array.from({ length: rows }).map((_, i) => (
        <ProjectCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Full-width skeleton for the projects header (title/subtitle + buttons) — optional polish. */
export function ProjectsHeaderSkeleton() {
  return (
    <div className="mb-4 flex items-center justify-between gap-3" aria-hidden="true">
      <div className="grid gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
    </div>
  );
}

/** Destructive Alert + retry, with explicit ApiClientError text. */
export function ErrorState({
  message,
  onRetry,
  title,
  retryLabel,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
  retryLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <Alert variant="destructive">
      <AlertTitle>{title ?? t.errors.somethingWentWrong}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      {onRetry && (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel ?? t.common.retry}
          </Button>
        </div>
      )}
    </Alert>
  );
}

/** Flat empty placeholder — §6, no Card/border/background, transparent. */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Empty className="border-0 bg-transparent shadow-none">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {actionLabel && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
