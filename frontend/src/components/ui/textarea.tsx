'use client';

import React, { forwardRef } from 'react';
import { cn } from '../../lib/cn';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, className, id, ...props },
  ref,
) {
  const textareaId = id || props.name;
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label
          htmlFor={textareaId}
          className="block text-[10px] font-semibold text-slate-500 uppercase mb-1"
        >
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        className={cn(
          'w-full px-3 py-2 border rounded-lg text-xs bg-white transition-colors',
          'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15',
          error ? 'border-danger' : 'border-line',
        )}
        {...props}
      />
      {error && <p className="text-danger text-xs mt-1">{error}</p>}
    </div>
  );
});

export default Textarea;
