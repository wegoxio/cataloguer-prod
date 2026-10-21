'use client';

import React, { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  // 'dark' restyles for placement on a dark card (the navy auth pages)
  tone?: 'light' | 'dark';
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, className, id, type, tone = 'light', ...props },
  ref,
) {
  const inputId = id || props.name;
  // Every password field gets a visibility toggle
  const isPassword = type === 'password';
  const [revealed, setRevealed] = useState(false);
  const dark = tone === 'dark';

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label
          htmlFor={inputId}
          className={cn('block text-[10px] font-semibold uppercase mb-1', dark ? 'text-slate-300' : 'text-slate-500')}
        >
          {label}
        </label>
      )}
      <div className={isPassword ? 'relative' : undefined}>
        <input
          ref={ref}
          id={inputId}
          type={isPassword && revealed ? 'text' : type}
          className={cn(
            'w-full px-3 py-2 border rounded-lg text-xs transition-colors',
            'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15',
            dark
              ? 'bg-white/5 text-white placeholder:text-slate-500'
              : 'bg-white',
            isPassword && 'pr-9',
            error ? 'border-danger' : dark ? 'border-white/15' : 'border-line',
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            onClick={() => setRevealed((prev) => !prev)}
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2',
              dark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-400 hover:text-slate-600',
            )}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
      {error && <p className={cn('text-xs mt-1', dark ? 'text-red-300' : 'text-danger')}>{error}</p>}
    </div>
  );
});

export default Input;
