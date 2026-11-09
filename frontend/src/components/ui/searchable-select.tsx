'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SearchableSelectOption {
  value: string;
  label: string;
  searchText?: string;
}

export function SearchableSelect({
  label,
  value,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matching options',
  disabled = false,
  error,
  onChange,
}: {
  label: string;
  value: string;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => options.filter((option) =>
      !normalizedQuery || `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase().includes(normalizedQuery),
    ),
    [normalizedQuery, options],
  );

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="w-full" ref={rootRef}>
      <span className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">{label}</span>
      <div className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen((current) => !current); setQuery(''); }}
          className={cn(
            'flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-left text-xs font-medium transition-colors',
            'focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
            error ? 'border-danger' : 'border-line',
          )}
        >
          <span className={cn('min-w-0 truncate', !selected && 'text-slate-400')}>{selected?.label ?? placeholder}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
        </button>
        {open && !disabled && (
          <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl" role="listbox">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-10 min-w-0 flex-1 border-0 bg-transparent text-xs outline-none placeholder:text-slate-400"
              />
              {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X className="h-3.5 w-3.5 text-slate-400" /></button>}
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {filtered.length === 0 && <p className="px-3 py-5 text-center text-xs text-slate-400">{emptyMessage}</p>}
              {filtered.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value || '__empty'}
                  onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-xs transition-colors hover:bg-slate-50',
                    option.value === value && 'bg-primary/10 font-semibold text-primary',
                  )}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
