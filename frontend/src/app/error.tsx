'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import ErrorState from '../components/layout/error-state';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error, { tags: { boundary: 'app' } });
  }, [error]);

  return <ErrorState reset={reset} digest={error.digest} />;
}
