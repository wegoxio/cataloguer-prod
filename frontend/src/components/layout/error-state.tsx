'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import Button from '../ui/button';

export default function ErrorState({
  title = 'No pudimos cargar esta sección',
  message = 'Tus datos no se han perdido. Inténtalo de nuevo y, si continúa, vuelve al panel.',
  reset,
  digest,
}: {
  title?: string;
  message?: string;
  reset: () => void;
  digest?: string;
}) {
  return (
    <div className="min-h-[45vh] flex items-center justify-center p-6" role="alert">
      <div className="card max-w-md p-7 text-center space-y-3">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <h2 className="text-lg font-bold text-slate-800">{title}</h2>
        <p className="text-sm text-slate-500">{message}</p>
        {digest ? <p className="font-mono text-[10px] text-slate-400">Referencia: {digest}</p> : null}
        <Button onClick={reset} className="mx-auto">
          <RotateCcw className="h-4 w-4" /> Volver a intentar
        </Button>
      </div>
    </div>
  );
}
