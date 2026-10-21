import { NextRequest, NextResponse } from 'next/server';

/**
 * The panel's home is catalog.wegox.io; the old app.wegoxcatalog.com
 * permanently redirects there (path + query preserved) so bookmarks,
 * emailed links and the demo sites keep working.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get('host') || '';
  if (host === 'app.wegoxcatalog.com') {
    const url = new URL(request.url);
    url.host = 'catalog.wegox.io';
    url.port = '';
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Skip static assets: only page/API-ish routes need the host check
  matcher: ['/((?!_next/|brand/|favicon|icon).*)'],
};
