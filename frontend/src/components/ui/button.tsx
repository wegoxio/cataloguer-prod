'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import Tooltip from './tooltip';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT_STYLES: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover border border-transparent',
  secondary: 'bg-white text-slate-700 border border-line hover:bg-slate-50',
  danger: 'bg-red-50 text-danger border border-red-200 hover:bg-red-100',
  ghost: 'bg-transparent text-slate-600 border border-transparent hover:bg-slate-200/60',
};

const SIZE_STYLES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
  /** Hover description of the action, shown as a small popup. */
  tooltip?: string;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  tooltip,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  const button = (
    <button
      disabled={disabled || isLoading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className,
      )}
      {...props}
    >
      {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );

  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}
