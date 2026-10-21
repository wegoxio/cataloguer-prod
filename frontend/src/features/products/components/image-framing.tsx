'use client';

import React from 'react';

/** The two ways a website can frame a product photo. */
export function ModePicker({
  mode,
  onChange,
  t,
}: {
  mode: 'CONTAIN' | 'COVER';
  onChange: (mode: 'CONTAIN' | 'COVER') => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold w-fit">
      {(['CONTAIN', 'COVER'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`px-3 py-1.5 transition-colors ${
            mode === option ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          {option === 'CONTAIN' ? t('Whole photo (recommended)') : t('Fill the frame (crops edges)')}
        </button>
      ))}
    </div>
  );
}

/** Mini replica of a website product card so the framing choice is visual. */
export function CardPreview({
  url,
  mode,
  name,
  t,
}: {
  url: string;
  mode: 'CONTAIN' | 'COVER';
  name: string;
  t: (key: string) => string;
}) {
  return (
    <div className="w-[190px] shrink-0 rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
      <div className="h-[126px] relative bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className={
            mode === 'COVER'
              ? 'absolute inset-0 h-full w-full object-cover'
              : 'absolute inset-0 h-full w-full object-contain p-2 bg-white'
          }
        />
      </div>
      <div className="p-2.5">
        <p className="text-xs font-semibold text-slate-700 truncate">{name}</p>
        <p className="text-[10px] text-slate-400">{t('How it will look on the website')}</p>
      </div>
    </div>
  );
}
