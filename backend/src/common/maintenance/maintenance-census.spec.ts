import * as fs from 'fs';
import * as ts from 'typescript';
import { productionFiles, SRC_ROOT } from '../../../test/inventory-writer-scan';
import { REFUSED_METHODS } from './maintenance';

/**
 * P5-X1 — the structural census behind the maintenance guarantee.
 *
 * The guard refuses POST/PUT/PATCH/DELETE. That only covers "every inventory
 * mutation" if two facts hold, and both are asserted here rather than assumed:
 *
 *  1. No inventory-writing service is reachable from a SAFE HTTP method. A
 *     `@Get` handler that posted a command would sail straight through a guard
 *     keyed on the verb.
 *  2. Nothing writes inventory outside a request at all — no cron, no
 *     interval, no scheduler, no bootstrap hook. A background writer has no
 *     HTTP method to refuse.
 *
 * Where this census is deliberately not the whole proof: it sees direct
 * references, not transitive call graphs. That is why the per-organization
 * freeze exists in `InventoryPostingService` — the inner guarantee holds for
 * callers this scan cannot see, which is exactly the class of caller a static
 * census is weakest against.
 */

/** Every service through which inventory can change. */
const INVENTORY_WRITERS = [
  'InventoryPostingService',
  'InventoryStockService',
  'InventoryReservationService',
  'InventoryTransferService',
  'InventoryCommandService',
  'InventoryOpeningService',
];

const SAFE_METHOD_DECORATORS = ['Get', 'Head', 'Options'];

interface RouteHit {
  file: string;
  method: string;
  handler: string;
  writers: string[];
}

const routeDecorator = (node: ts.MethodDeclaration): string | null => {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
    const name = call.expression.text;
    if ([...SAFE_METHOD_DECORATORS, ...REFUSED_METHODS.map((m) => m[0] + m.slice(1).toLowerCase())].includes(name)) {
      return name;
    }
  }
  return null;
};

const collectRoutes = (file: string, source: string): RouteHit[] => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: RouteHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const method = routeDecorator(node);
      if (method) {
        const body = node.body ? node.body.getText(tree) : '';
        const writers = INVENTORY_WRITERS.filter((writer) => body.includes(writer));
        hits.push({
          file,
          method,
          handler: ts.isIdentifier(node.name) ? node.name.text : '<computed>',
          writers,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return hits;
};

describe('P5-X1 maintenance-mode coverage census', () => {
  const files = productionFiles().filter((file) => file.endsWith('.controller.ts'));
  const routes = files.flatMap((file) =>
    collectRoutes(file.replace(`${SRC_ROOT}/`, ''), fs.readFileSync(file, 'utf8')),
  );

  it('finds controllers to scan at all — a census over nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(routes.length).toBeGreaterThan(50);
  });

  it('no safe-method route references an inventory writer', () => {
    const offenders = routes
      .filter((route) => SAFE_METHOD_DECORATORS.includes(route.method))
      .filter((route) => route.writers.length > 0)
      .map((route) => `${route.file}::${route.handler} (${route.method}) -> ${route.writers.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('every route that references an inventory writer uses a refused method', () => {
    const writing = routes.filter((route) => route.writers.length > 0);
    for (const route of writing) {
      expect(REFUSED_METHODS).toContain(route.method.toUpperCase());
    }
  });

  it('no background or scheduled machinery exists anywhere in the source', () => {
    // A cron job has no HTTP verb, so maintenance mode cannot refuse it. The
    // repository has none; this asserts it stays that way rather than trusting
    // that nobody adds one.
    const forbidden = [/@Cron\(/, /@Interval\(/, /@Timeout\(/, /ScheduleModule/, /setInterval\(/];
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${file.replace(`${SRC_ROOT}/`, '')} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the retired cutover operator is absent from the runtime', () => {
    const appModule = fs.readFileSync(`${SRC_ROOT}/app.module.ts`, 'utf8');
    expect(appModule).not.toContain('CutoverModule');
    expect(appModule).not.toContain('CutoverService');
  });
});
