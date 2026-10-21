'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import Input from '../../components/ui/input';
import Button from '../../components/ui/button';
import AuthCard from '../../components/layout/auth-card';
import { useT } from '../../lib/i18n';

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      await apiFetch('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    } catch {
      // Same generic outcome either way — no user enumeration
    } finally {
      setSent(true);
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      {sent ? (
        <div className="text-center space-y-3">
          <MailCheck className="h-10 w-10 mx-auto text-emerald-400" />
          <h2 className="text-xl font-bold text-white">{t('Check your inbox')}</h2>
          <p className="text-sm text-slate-400">
            {t('If')} <span className="font-semibold text-slate-200">{email}</span> {t('has an account, a reset link is on its way. It works once and expires in 45 minutes.')}
          </p>
          <Link href="/login" className="text-sm text-primary hover:underline inline-block pt-2">
            {t('Back to sign in')}
          </Link>
        </div>
      ) : (
        <>
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-white">{t('Forgot your password?')}</h2>
            <p className="text-xs text-slate-400 mt-1">
              {t("Enter your email and we'll send you a reset link")}
            </p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Input
              tone="dark"
              type="email"
              label={t('Email Address')}
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" isLoading={busy} className="w-full">
              {t('Send reset link')}
            </Button>
            <p className="text-center">
              <Link href="/login" className="text-xs text-slate-400 hover:text-white">
                {t('Back to sign in')}
              </Link>
            </p>
          </form>
        </>
      )}
    </AuthCard>
  );
}
