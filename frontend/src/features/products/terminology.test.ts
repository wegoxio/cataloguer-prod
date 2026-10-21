import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { describe, expect, it } from 'vitest';

/**
 * ADR 018 — the retired role words must not reach a user, in either language.
 *
 * A rendered-output check is not enough on its own: most of a panel's copy only
 * appears in states a single render never reaches, so a string can regress
 * without any test seeing it. This reads the SOURCE instead, so every
 * user-facing literal is covered whether or not some test happens to render it.
 *
 * `family` is deliberately absent from the forbidden list: it survives as the
 * internal collective term (routes, services, test ids) and, as
 * "Parent and children", as the one section title. It is never a product role.
 */
// vitest runs from the frontend package root, which is where `src` lives.
const ROOT = process.cwd();
const files = execSync('git ls-files src', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && existsSync(join(ROOT, file)));

const RETIRED_EN = /\b(variant|variants|model|models|version|versions)\b/i;
const RETIRED_ES = /\b(variante|variantes|versión|versiones|modelo|modelos)\b/i;

describe('ADR 018 · retired role words never reach a user', () => {
  it('no English user-facing string uses variant, model or version', () => {
    const offenders: string[] = [];
    const call = /\bt\(\s*'((?:[^'\\\n]|\\.)*)'/g;
    for (const file of files) {
      if (file.endsWith('translations.es.ts')) continue;
      const source = readFileSync(join(ROOT, file), 'utf8');
      let match: RegExpExecArray | null;
      call.lastIndex = 0;
      while ((match = call.exec(source)) !== null) {
        if (RETIRED_EN.test(match[1])) offenders.push(`${file}: ${match[1].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Spanish translation uses variante, modelo or versión', () => {
    const source = readFileSync(join(ROOT, 'src', 'lib', 'translations.es.ts'), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      // "invariante" merely contains the word; it is not a product role.
      .filter(([, line]) => RETIRED_ES.test(line) && !/invariante/i.test(line))
      .map(([n, line]) => `${n}: ${line.trim().slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it('keeps family as the internal collective term, not as a role', () => {
    const panel = readFileSync(join(ROOT, 'src/features/products/components/product-family-panel.tsx'), 'utf8');
    // The routes and test ids still say family, deliberately…
    expect(panel).toContain('data-testid="family-panel"');
    // …and BOTH headings a person reads say the two roles instead. Counting
    // matters: a `toContain` passes while one of the two has been replaced by
    // some fourth noun, which is exactly the drift this pins.
    expect(panel.match(/t\('Parent and children'\)/g)).toHaveLength(2);
  });
});
