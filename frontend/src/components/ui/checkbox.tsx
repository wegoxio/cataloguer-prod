'use client';

import React, { forwardRef } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...props },
  ref,
) {
  return (
    <label className={cn('inline-flex items-center gap-2 cursor-pointer select-none', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary"
        {...props}
      />
      <span className="text-xs font-semibold text-slate-700">{label}</span>
    </label>
  );
});

export default Checkbox;
