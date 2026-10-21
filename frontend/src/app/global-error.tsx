'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/** Last-resort boundary: reports the crash and offers a reload. */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="es">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#f1f5f9', color: '#1d2433' }}>
        <div style={{ maxWidth: 420, margin: '15vh auto', textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>Algo salió mal</h2>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 8 }}>
            El error fue reportado automáticamente. Intenta recargar la página.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              background: '#3762e3',
              color: '#fff',
              border: 0,
              borderRadius: 10,
              padding: '10px 20px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Recargar
          </button>
        </div>
      </body>
    </html>
  );
}
