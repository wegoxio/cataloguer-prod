import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';

/**
 * Every module we import at RUNTIME is one we declare.
 *
 * pnpm builds a strict `node_modules`: a package that is only a transitive
 * dependency of something we declared is NOT resolvable by our own code. So an
 * undeclared import is not a style question — it is a program that works only
 * because of where a package manager happened to hoist something, and stops
 * working the day that changes.
 *
 * `express` was exactly that. Three files imported `Response` and `Request`
 * from it in VALUE position for what are purely types. `tsc` erases such
 * imports, so the shipped `dist/` never asked for the package and nothing was
 * wrong in production — but any transpiler that cannot do type analysis
 * (`ts-node/register/transpile-only`, `esbuild`, `swc`) emits a real
 * `require('express')`, which fails. That is how the job entrypoint could not be
 * run from source while running perfectly from `dist/`.
 *
 * The resolution is the smallest correct one: the source contract genuinely
 * needs Express's types, `@types/express` is already a declared devDependency,
 * and `import type` makes the erasure explicit rather than incidental.
 */

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND_ROOT, 'src');

const manifest = JSON.parse(readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);

/** Every `.ts` under `src`, comments stripped so prose cannot trip a guard. */
function sources(): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const raw = readFileSync(full, 'utf8');
      // A guard that fires on a sentence in a comment gets deleted by the next
      // person who trips over it.
      const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      found.push({ file: path.relative(BACKEND_ROOT, full), body });
    }
  };

  walk(SRC);
  return found;
}

/** The package a specifier names, ignoring deep paths and relative imports. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Node's own modules are always available and are never declared. */
const BUILTIN =
  /^(node:)?(fs|path|crypto|http|https|net|os|url|util|stream|zlib|events|child_process|buffer|assert|timers|worker_threads|perf_hooks|dns|tls|string_decoder|readline|querystring|module|process|v8|tty|cluster|constants|async_hooks|diagnostics_channel)$/;

describe('every runtime import is a declared dependency', () => {
  const files = sources();

  it('reads the whole source tree, so the guard cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('imports no package we have not declared', () => {
    const offenders: string[] = [];

    for (const { file, body } of files) {
      // VALUE-position imports and requires only. `import type` is erased by
      // every transpiler and needs only the types package, which is declared
      // separately — so it is deliberately not an offender here.
      const specifiers = [
        ...body.matchAll(/(?<!import\s+type\s)(?:^|\n)\s*import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g),
        ...body.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),
        ...body.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        const pkg = packageOf(specifier);
        if (!pkg || BUILTIN.test(pkg) || declared.has(pkg)) continue;
        offenders.push(`${file} imports "${pkg}"`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never imports express in value position, since only its TYPES are used', () => {
    // Named separately from the general rule because this one has a history:
    // it is why the runner entrypoint could be run from `dist/` and not from
    // source, and the failure said nothing about the job.
    const valueImports = files.filter(({ body }) =>
      /(?<!import\s+type\s)import\s+\{[^}]*\}\s+from\s+['"]express['"]/.test(body),
    );

    expect(valueImports.map(({ file }) => file)).toEqual([]);
  });

  it('declares the Express types the source contract actually requires', () => {
    // The controllers take `@Res() res: Response` and call `res.cookie(...)`,
    // which is Express's API and not Nest's. The contract is real; what was
    // missing was saying so.
    expect(declared.has('@types/express')).toBe(true);
    expect(declared.has('@nestjs/platform-express')).toBe(true);
  });
});
