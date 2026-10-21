'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../../lib/auth';

export default function Topbar() {
  const { user } = useAuth();
  const pathname = usePathname();

  // The dashboard has its own chrome; the landing has its own navbar; the
  // auth pages (login, welcome, password flows) show the logo in their card
  const AUTH_ROUTES = ['/login', '/welcome', '/forgot-password', '/reset-password'];
  if (
    pathname.startsWith('/dashboard') ||
    pathname === '/' ||
    AUTH_ROUTES.some((route) => pathname.startsWith(route))
  ) {
    return null;
  }

  return (
    <header className="h-16 flex items-center justify-between px-6 shrink-0">
      <Link
        href={user ? '/dashboard' : '/login'}
        className="text-lg font-bold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent"
      >
        Catalog
      </Link>
    </header>
  );
}
