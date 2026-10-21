'use client';

import React from 'react';
import { usePathname } from 'next/navigation';

export default function SiteFooter() {
  const pathname = usePathname();
  // The landing renders its own full footer
  if (pathname === '/') return null;

  return (
    <footer className="h-10 flex items-center justify-center gap-4 text-xs text-slate-500 shrink-0">
      <span>Powered by Wegox</span>
      <span className="text-slate-300">·</span>
      <a href="/terminos" className="hover:text-primary">Términos</a>
      <a href="/privacidad" className="hover:text-primary">Privacidad</a>
    </footer>
  );
}
