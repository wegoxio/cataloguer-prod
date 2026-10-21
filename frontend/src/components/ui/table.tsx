import React from 'react';
import { cn } from '../../lib/cn';

/**
 * Attributes a caller may put on the scrolling box: a region role and name, a
 * tab stop while the box actually overflows, and `data-*` facts a test can
 * read. The caller decides them from what it measures; this primitive only
 * places them.
 */
export type TableWrapperProps = React.HTMLAttributes<HTMLDivElement> & {
  [attribute: `data-${string}`]: string | undefined;
};

export function Table({
  className,
  wrapperProps,
  children,
}: {
  className?: string;
  wrapperProps?: TableWrapperProps;
  children: React.ReactNode;
}) {
  return (
    <div
      {...wrapperProps}
      className={cn(
        'overflow-x-auto border border-line rounded-xl bg-white shadow-card',
        className,
        wrapperProps?.className,
      )}
    >
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-slate-50">
      <tr>{children}</tr>
    </thead>
  );
}

export const TH = React.forwardRef<
  HTMLTableCellElement,
  {
    className?: string;
    align?: 'left' | 'right' | 'center';
    /** Inline geometry a caller has MEASURED, e.g. a sticky column's offset. */
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }
>(function TH({ className, align = 'left', style, children }, ref) {
  return (
    <th
      ref={ref}
      // Every cell in `THead` is a COLUMN header, and saying so is what lets a
      // screen reader announce "Role: Standalone" when the reader lands on a
      // cell instead of reading a bare word.
      scope="col"
      style={style}
      className={cn(
        'px-4 py-3 text-[10px] font-semibold text-ink-muted uppercase tracking-[0.08em]',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
});

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TR({ className, children }: { className?: string; children: React.ReactNode }) {
  return <tr className={className}>{children}</tr>;
}

export function TD({
  className,
  align = 'left',
  style,
  children,
}: {
  className?: string;
  align?: 'left' | 'right' | 'center';
  /** Inline geometry a caller has MEASURED, e.g. a sticky column's offset. */
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <td
      style={style}
      className={cn(
        'px-4 py-3',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * Nothing here, and what to do about it.
 *
 * An empty state that only says "nothing found" leaves the reader to work out
 * whether they have an empty catalogue or an over-narrow filter, and gives them
 * nothing to press either way. `action` is where the way out goes — omitted
 * when there is genuinely nothing to offer, or when the reader is not allowed
 * to do it.
 */
export function EmptyState({
  message,
  hint,
  action,
  testId,
}: {
  message: string;
  hint?: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="p-8 text-center border border-dashed border-slate-300 rounded-xl bg-white/60"
      data-testid={testId}
    >
      <p className="text-slate-500 text-sm font-medium">{message}</p>
      {hint && <p className="text-slate-400 text-xs mt-1">{hint}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
