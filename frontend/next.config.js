const { withSentryConfig } = require('@sentry/nextjs/config');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Protected pages must not be replayable from the HTTP cache or restored
  // wholesale after sign-out. The app is client-rendered, so the payload a
  // cache could keep is small — but back-navigation restoring a rendered
  // dashboard after logout is exactly the stale-tenant-data case this closes.
  async headers() {
    return [
      {
        source: '/dashboard/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
  reactStrictMode: true,
  experimental: {
    // These packages expose very large barrels. Let Next include only the
    // icons/SDK entry points each route actually imports.
    optimizePackageImports: ['lucide-react', '@sentry/nextjs'],
  },
  // src/instrumentation.ts (Sentry server init) is stable on Next 15 — the old
  // experimental.instrumentationHook flag no longer exists and must not be set.
};

// Source-map upload stays off (no SENTRY_AUTH_TOKEN); this wrapper only
// wires the SDK's build-time pieces.
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  widenClientFileUpload: false,
  disableLogger: true,
});
