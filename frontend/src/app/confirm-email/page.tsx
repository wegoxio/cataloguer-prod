'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, MailWarning } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useT } from '../../lib/i18n';

/** Landing page for the link emailed to the NEW address. */
export default function ConfirmEmailPage() {
  const t = useT();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  // window.location instead of useSearchParams: avoids the Suspense
  // requirement for prerendered pages
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setState('error');
      setError('Missing token');
      return;
    }
    apiFetch('/auth/confirm-email-change', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        setEmail(res?.data?.email ?? '');
        setState('done');
      })
      .catch((err: any) => {
        setError(err.message || '');
        setState('error');
      });
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="card p-8 max-w-md w-full text-center space-y-4">
        {state === 'working' && (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-sm text-slate-500">{t('Confirming your new email...')}</p>
          </>
        )}
        {state === 'done' && (
          <>
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
            <h2 className="text-lg font-bold text-slate-800">{t('Email changed')}</h2>
            <p className="text-sm text-slate-500">
              {t('From now on, sign in with')} <span className="font-semibold text-slate-700">{email}</span>.{' '}
              {t('For security, every session was signed out.')}
            </p>
            <Link
              href="/login"
              className="inline-block bg-primary text-white text-sm font-semibold px-5 py-2 rounded-md hover:opacity-90"
            >
              {t('Go to sign in')}
            </Link>
          </>
        )}
        {state === 'error' && (
          <>
            <MailWarning className="h-10 w-10 text-amber-500 mx-auto" />
            <h2 className="text-lg font-bold text-slate-800">{t('This link no longer works')}</h2>
            <p className="text-sm text-slate-500">
              {error || t('The link is invalid or has expired. Request the change again from Settings.')}
            </p>
            <Link href="/login" className="text-sm font-semibold text-primary hover:underline">
              {t('Go to sign in')}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
