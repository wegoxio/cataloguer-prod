'use client';

import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useAuth } from '../../lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Input from '../../components/ui/input';
import Button from '../../components/ui/button';
import AuthCard from '../../components/layout/auth-card';
import { useT } from '../../lib/i18n';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginSchema = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const t = useT();
  const { login, verifyMfa, user, isLoading } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginSchema>({
    resolver: zodResolver(loginSchema),
  });

  useEffect(() => {
    if (!isLoading && user) {
      router.push('/dashboard');
    }
  }, [user, isLoading, router]);

  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);

  const onSubmit = async (data: LoginSchema) => {
    setError(null);
    try {
      const result = await login(data.email, data.password);
      if (result?.mfaRequired && result.challengeToken) {
        setMfaChallenge(result.challengeToken);
        return;
      }
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check your credentials.');
    }
  };

  const onVerifyMfa = async () => {
    if (!mfaChallenge) return;
    setError(null);
    setMfaBusy(true);
    try {
      await verifyMfa(mfaChallenge, mfaCode);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Invalid code');
    } finally {
      setMfaBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-slate-500 text-sm">{t('Checking session...')}</p>
      </div>
    );
  }

  return (
    <AuthCard>
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-white">{t('Sign In')}</h2>
        <p className="text-xs text-slate-400 mt-1">{t('Access the Product Catalogue Management Panel')}</p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded-md">
          {error}
        </div>
      )}

      {mfaChallenge ? (
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            {t('Enter the 6-digit code from your authenticator app (or a recovery code).')}
          </p>
          <Input
            tone="dark"
            label={t('Verification code')}
            placeholder="123456"
            autoFocus
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onVerifyMfa();
            }}
          />
          <Button className="w-full" isLoading={mfaBusy} onClick={onVerifyMfa}>
            {t('Verify')}
          </Button>
          <button
            type="button"
            className="w-full text-center text-xs text-slate-400 hover:text-white"
            onClick={() => {
              setMfaChallenge(null);
              setMfaCode('');
              setError(null);
            }}
          >
            {t('Back to password')}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            tone="dark"
            type="email"
            label={t('Email Address')}
            placeholder="you@company.com"
            error={errors.email?.message}
            {...register('email')}
          />
          <Input
            tone="dark"
            type="password"
            label={t('Password')}
            placeholder="••••••••"
            error={errors.password?.message}
            {...register('password')}
          />
          <Button type="submit" isLoading={isSubmitting} className="w-full">
            {t('Sign In')}
          </Button>
          <p className="text-center">
            <Link href="/forgot-password" className="text-xs text-slate-400 hover:text-white">
              {t('Forgot your password?')}
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
