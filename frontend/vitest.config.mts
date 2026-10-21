import { defineConfig } from 'vitest/config';

/**
 * The panel's test runtime (P5-W5).
 *
 * THE SMALLEST MECHANISM THAT PROVES BEHAVIOUR. Before this file the suite was
 * pure-function tests only (`vitest run --dir src`, no config, no DOM), which
 * can check a capability predicate but cannot show that a CONTROL is absent
 * for a denied actor or that a HANDLER refuses when it is reached anyway —
 * and those two are the Phase 5 acceptance conditions.
 *
 * ONE new development dependency: `happy-dom`, an optional peer vitest already
 * declares and pinned to an exact version. Nothing else was added — no
 * component-testing library and no React plugin — because React 18's own
 * `createRoot` + `act` and a real DOM `click()` are enough: React attaches its
 * listeners at the container root, so a genuine bubbling DOM event reaches the
 * component's handler exactly as a user's would. `src/test/render.tsx` is the
 * whole harness.
 *
 * `.mts` rather than `.ts`: this package is CommonJS (Next's own config files
 * are), and Vite's native config loader warns about ESM syntax in a file it
 * loads as CommonJS. The extension states the module system instead of
 * changing the package's, which would break `next.config.js` and
 * `postcss.config.js`.
 *
 * No `include` is declared. `pnpm test` already passes `--dir src`, and adding
 * an `src/**` include on top of it resolves to `src/src/**` and matches
 * nothing — the command and the config each get to say one thing.
 */
export default defineConfig({
  // The app's tsconfig says `"jsx": "preserve"` because Next compiles JSX
  // itself, so the test transformer has to be told explicitly; without this
  // every .tsx test file fails to parse.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'happy-dom',
    // Spawning one worker for every test file overwhelmed Windows and made
    // otherwise instant dynamic imports hit the five-second timeout. Eight
    // isolated workers preserve mock boundaries without creating 90 runtimes
    // (and 90 simultaneous API probes) on a full run.
    maxWorkers: 8,
    // A full Windows run creates a fresh happy-dom environment per file. A
    // test that takes milliseconds in isolation can occasionally spend most
    // of the default five seconds waiting for CPU while eight environments
    // start together; ten seconds still catches hangs without making the
    // suite randomly fail under load.
    testTimeout: 10_000,
  },
});
