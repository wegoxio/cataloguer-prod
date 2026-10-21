'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import Input from '../../components/ui/input';
import Button from '../../components/ui/button';
import AuthCard from '../../components/layout/auth-card';
import { useT } from '../../lib/i18n';
import { isStrongPassword, PASSWORD_POLICY_HINT } from '../../lib/password';

/**
 * Invitation landing page. The emailed link carries a single-use token;
 * choosing a password here activates the account. Reuses the reset-password
 * endpoint — an invite is simply the account's first password.
 */
export default function WelcomePage() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [done, setDone] = useState(false);

  // window.location instead of useSearchParams: avoids the Suspense
  // requirement for prerendered pages
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token'));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!isStrongPassword(password)) {
      setError(t(PASSWORD_POLICY_HINT));
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password, acceptTerms: true }),
      });
      setDone(true);
    } catch (err: any) {
      setError(
        err.message ||
          'This invitation is invalid or has expired — ask your administrator to send a new one.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      {done ? (
        <div className="text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-400" />
          <h2 className="text-xl font-bold text-white">{t('Your account is ready')}</h2>
          <p className="text-sm text-slate-400">{t('Sign in with your email and your new password.')}</p>
          <Link
            href="/login"
            className="inline-block mt-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-md hover:opacity-90"
          >
            {t('Sign in')}
          </Link>
        </div>
      ) : token === null ? (
        <div className="text-center space-y-3">
          <KeyRound className="h-10 w-10 mx-auto text-slate-500" />
          <p className="text-sm text-slate-400">{t('Loading…')}</p>
        </div>
      ) : token === '' ? (
        <div className="text-center space-y-3">
          <KeyRound className="h-10 w-10 mx-auto text-amber-400" />
          <h2 className="text-xl font-bold text-white">{t('Missing invitation link')}</h2>
          <p className="text-sm text-slate-400">
            {t('Open this page from the invitation email, or ask your administrator to resend it.')}
          </p>
        </div>
      ) : (
        <>
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-white">{t('Welcome to Catalog by Wegox')}</h2>
            <p className="text-xs text-slate-400 mt-1">
              {t('Choose a password to activate your account.')} {t(PASSWORD_POLICY_HINT)}
            </p>
          </div>
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded-md">
              {error}
            </div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <Input
              tone="dark"
              type="password"
              label={t('Password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Input
              tone="dark"
              type="password"
              label={t('Confirm Password')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            <label className="flex items-start gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                required
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-white/20 bg-white/5 text-primary focus:ring-primary"
              />
              <span>
                {t('I accept the')}{' '}
                <a href="/terminos" target="_blank" className="text-primary hover:underline">
                  {t('Terms of Service')}
                </a>{' '}
                {t('and the')}{' '}
                <a href="/privacidad" target="_blank" className="text-primary hover:underline">
                  {t('Privacy Policy')}
                </a>
              </span>
            </label>
            <Button type="submit" isLoading={busy} disabled={!termsAccepted} className="w-full">
              {t('Activate my account')}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
