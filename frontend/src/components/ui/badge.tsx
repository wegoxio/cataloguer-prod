import React from 'react';
import { cn } from '../../lib/cn';

type Variant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'purple' | 'accent';

const VARIANT_STYLES: Record<Variant, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-600',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-blue-50 text-blue-700',
  neutral: 'bg-slate-200/70 text-slate-600',
  purple: 'bg-purple-50 text-purple-700',
  // The orange "spark" — for highlight tags (Nuevo, Destacado) only
  accent: 'bg-accent-tint text-accent-ink',
};

export interface BadgeProps {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
  /**
   * A test hook, forwarded to the DOM.
   *
   * The props were destructured and everything else discarded, so a
   * `data-testid` passed to a Badge silently went nowhere — the product detail
   * page has carried one on its "Not purchasable" badge since PR A that no
   * selector could ever find. Named explicitly rather than spread, so the
   * component still accepts nothing else by accident.
   */
  'data-testid'?: string;
}

export default function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      data-testid={rest['data-testid']}
      className={cn(
        'inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap',
        VARIANT_STYLES[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
