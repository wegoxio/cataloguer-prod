'use client';

import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, className, id, children, ...props },
  ref,
) {
  const selectId = id || props.name;
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label htmlFor={selectId} className="block text-[10px] font-semibold text-slate-500 uppercase mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'w-full pl-2 pr-7 py-2 border rounded-lg text-xs leading-5 bg-white font-medium transition-colors appearance-none',
            'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15',
            error ? 'border-danger' : 'border-line',
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
      </div>
      {error && <p className="text-danger text-xs mt-1">{error}</p>}
    </div>
  );
});

export default Select;
