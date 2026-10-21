import React from 'react';
import Link from 'next/link';

/** Shared shell for the legal/company pages: readable article layout. */
export function LegalPage({ title, updated, children }: { title: string; updated?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-10">
      <article className="mx-auto max-w-3xl card p-8 sm:p-10">
        <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
        {updated && <p className="mt-1 text-xs text-slate-400">Última actualización: {updated}</p>}
        <div className="legal-body mt-6 space-y-4 text-sm leading-relaxed text-slate-600">{children}</div>
        <div className="mt-10 border-t border-slate-100 pt-4 text-xs text-slate-400">
          <Link href="/" className="text-primary hover:underline">
            ← wegoxcatalog.com
          </Link>
          {' · '}
          <Link href="/terminos" className="hover:text-primary">
            Términos
          </Link>
          {' · '}
          <Link href="/privacidad" className="hover:text-primary">
            Privacidad
          </Link>
          {' · '}
          <Link href="/aviso-legal" className="hover:text-primary">
            Aviso legal
          </Link>
          {' · '}
          <Link href="/sobre-nosotros" className="hover:text-primary">
            Sobre nosotros
          </Link>
        </div>
      </article>
    </div>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-4 text-base font-bold text-slate-800">{children}</h2>;
}
