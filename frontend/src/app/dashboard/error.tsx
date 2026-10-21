'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import ErrorState from '../../components/layout/error-state';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error, { tags: { boundary: 'dashboard' } });
  }, [error]);

  return (
    <ErrorState
      title="Esta sección del panel encontró un problema"
      message="El resto de tu sesión sigue activo. Puedes reintentar esta sección sin volver a iniciar sesión."
      reset={reset}
      digest={error.digest}
    />
  );
}
