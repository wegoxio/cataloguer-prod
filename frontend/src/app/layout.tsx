import type { Metadata } from 'next';
import { I18nProvider } from '../lib/i18n';
import { AppProviders } from '../lib/app-providers';
import Topbar from '../components/layout/topbar';
import SiteFooter from '../components/layout/site-footer';
import '../styles/globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://catalog.wegox.io'),
  title: 'Catalog by Wegox',
  description: 'Panel administrativo de Catalog by Wegox.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /*
      `h-full overflow-hidden` on the ROOT, not only on the body.

      CSS propagates the body's overflow to the viewport when the root's own
      overflow is `visible` — and in doing so the body's used overflow becomes
      `visible` too, so `overflow-hidden` there stops clipping the body box. The
      document was left free to scroll behind the dashboard's own scroller: two
      working scrollbars stacked between a person and a long mapping form, the
      outer one scrolling 2,441px of nothing and revealing empty ground below
      the shell. Measured, not guessed — `documentElement.scrollTop` moved.

      Giving the root a definite height and its own `overflow-hidden` settles
      the propagation: the viewport no longer scrolls, and the only scrollbar
      left is the inner one, closest to the content that actually overflows.
    */
    <html lang="en" className="h-full overflow-hidden">
      <body className="h-full flex flex-col overflow-hidden bg-ground text-ink-strong antialiased">
        <I18nProvider>
        <AppProviders>
            <Topbar />

            {/*
              Main Content Area: the dashboard and login layouts manage their own
              padding AND their own scrolling.

              This element deliberately does NOT scroll. It used to carry
              `overflow-y-auto` while the dashboard column carried another one
              inside it, so the page had two nested vertical scrollbars: the
              bottom of a long form was reachable only once BOTH were at their
              end, which is why action footers read as clipped and a grey band
              appeared below the content. One page, one scroll region — the inner
              one, closest to the content that actually overflows.
            */}
            <main className="flex-1 flex flex-col min-h-0">{children}</main>
        </AppProviders>
        </I18nProvider>
      </body>
    </html>
  );
}
