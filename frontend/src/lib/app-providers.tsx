'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth';
import { ToastProvider } from '../components/ui/toast';
import { queryClient } from './query-client';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
