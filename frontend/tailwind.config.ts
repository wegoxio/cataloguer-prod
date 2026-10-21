import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/features/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Design tokens: dark chrome + floating light content, soft oversized
      // shadows. Palette aligned to the Catalog logo (2026-07-15): blue is the
      // workhorse (actions, links, active), orange is the sparing accent/spark.
      colors: {
        primary: { DEFAULT: '#3762e3', hover: '#2f53c4' },
        // Orange "spark" — accents/highlights only, never a generic action.
        // tint/ink pair reads on light surfaces (badges, small emphasis).
        accent: { DEFAULT: '#f7931e', hover: '#e07d0a', tint: '#fef1e0', ink: '#b06a10' },
        // The sidebar's dark navy — primary buttons wear it for consistency
        chrome: { DEFAULT: '#101623', hover: '#1e293b' },
        secondary: '#64748b',
        danger: '#dc2626',
        success: '#16a34a',
        ground: '#d7dbe1', // page behind the floating shell
        shell: '#eaedf1', // content area inside the shell
        panel: '#f8fafc', // cards
        line: '#dde2e9', // hairline borders
        ink: { DEFAULT: '#3a4356', strong: '#1d2433', muted: '#6b7487' },
      },
      borderRadius: {
        card: '1rem',
      },
      boxShadow: {
        card: '0 8px 24px rgba(26, 35, 58, 0.06)',
        pop: '0 20px 44px rgba(26, 35, 58, 0.12)',
        shell: '0 18px 45px rgba(15, 23, 42, 0.18)',
        chrome: '0 3px 10px rgba(16, 22, 35, 0.25)',
      },
    },
  },
  plugins: [],
};
export default config;
