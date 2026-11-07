export type ChatErrorBannerProps = {
  message: string | null;
  onRetry?: () => void;
  retryLabel: string;
};
