'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, AlertCircle, Undo2, X } from 'lucide-react';
import { cn } from '../../lib/cn';

type ToastKind = 'success' | 'error' | 'undo';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastContextType {
  success: (message: string) => void;
  error: (message: string) => void;
  /** Destructive-action toast with a 10s window to take it back. */
  undo: (message: string, actionLabel: string, onAction: () => void) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const AUTO_DISMISS_MS = 4500;
// Longer window: the whole point is having time to change your mind
const UNDO_DISMISS_MS = 10000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>, dismissMs: number) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { ...toast, id }]);
      setTimeout(() => dismiss(id), dismissMs);
    },
    [dismiss],
  );

  const success = useCallback((message: string) => push({ kind: 'success', message }, AUTO_DISMISS_MS), [push]);
  const error = useCallback((message: string) => push({ kind: 'error', message }, AUTO_DISMISS_MS), [push]);
  const undo = useCallback(
    (message: string, actionLabel: string, onAction: () => void) =>
      push({ kind: 'undo', message, actionLabel, onAction }, UNDO_DISMISS_MS),
    [push],
  );

  return (
    <ToastContext.Provider value={{ success, error, undo }}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'flex items-start gap-2 p-3 rounded-xl border shadow-pop bg-white text-xs font-medium animate-in',
              toast.kind === 'success' && 'border-emerald-200',
              toast.kind === 'error' && 'border-red-200',
              toast.kind === 'undo' && 'border-slate-200',
            )}
            role="status"
          >
            {toast.kind === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
            ) : toast.kind === 'error' ? (
              <AlertCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
            ) : (
              <Undo2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            )}
            <span className="flex-1 text-slate-700">{toast.message}</span>
            {toast.kind === 'undo' && toast.actionLabel && (
              <button
                onClick={() => {
                  toast.onAction?.();
                  dismiss(toast.id);
                }}
                className="shrink-0 font-bold text-primary hover:underline"
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              onClick={() => dismiss(toast.id)}
              className="text-slate-300 hover:text-slate-500"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
