import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Structural scanning for the two P5-B1 writer gates.
 *
 * Both gates work the same way and for the same reason: a grep over source text
 * cannot tell an assignment from a comment, and a runtime test cannot see a
 * writer nobody calls yet. The TypeScript compiler API can do both, so the
 * question "what can write inventory?" is answered from the syntax tree.
 *
 * `ts.createSourceFile(..., true)` — the trailing `true` sets parent pointers,
 * which the enclosing-symbol walk needs. `createProgram` does not set them.
 */

export interface WriterHit {
  file: string;
  line: number;
  kind: 'ASSIGN' | 'OBJLIT' | 'RAWSQL';
  symbol: string;
  detail: string;
  key: string;
}

export const SRC_ROOT = path.join(__dirname, '..', 'src');

export const productionFiles = (root: string = SRC_ROOT): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.spec.ts')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
};

const enclosingSymbol = (node: ts.Node, sf: ts.SourceFile): string => {
  const names: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      names.push(current.name ? current.name.getText(sf) : 'constructor');
    }
    if (ts.isClassDeclaration(current) && current.name) names.push(current.name.getText(sf));
    current = current.parent;
  }
  return names.reverse().join('.') || '<module>';
};

/** Assignments to a plain `changes.<x>` audit-diff object are not entity writes. */
const AUDIT_DIFF = /^changes\./;

/**
 * Scans one source text for constructs that can persist a quantity matching
 * `namePattern`, or raw SQL mutating a table matching `sqlPattern`.
 */
export const scanSource = (
  relativeFile: string,
  source: string,
  namePattern: RegExp,
  sqlPattern: RegExp,
): WriterHit[] => {
  const sf = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true);
  const hits: WriterHit[] = [];
  const push = (node: ts.Node, kind: WriterHit['kind'], text: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const symbol = enclosingSymbol(node, sf);
    hits.push({
      file: relativeFile,
      line: line + 1,
      kind,
      symbol,
      detail: text.slice(0, 120).replace(/\s+/g, ' '),
      key: `${relativeFile}::${symbol}::${kind}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(
        node.operatorToken.kind,
      ) &&
      ts.isPropertyAccessExpression(node.left) &&
      namePattern.test(node.left.name.getText(sf))
    ) {
      if (!AUDIT_DIFF.test(node.getText(sf).replace(/\s+/g, ' '))) push(node, 'ASSIGN', node.getText(sf));
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name &&
      namePattern.test(node.name.getText(sf))
    ) {
      push(node, 'OBJLIT', node.getText(sf));
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf);
      if (sqlPattern.test(text) && /\b(update|insert\s+into|delete\s+from)\b/i.test(text)) {
        push(node, 'RAWSQL', text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
};

/**
 * Scans one source text for SQL LITERALS matching a pattern, with no
 * write-verb requirement (P5-C2B).
 *
 * `scanSource` deliberately only reports a literal that also contains
 * `insert`/`update`/`delete`, because its question is "what can write?". The
 * privilege split moved the ledger writes behind `SECURITY DEFINER` functions,
 * so the posting service now issues `select inventory_definer_...(...)` — a
 * statement that writes, through a door, while containing none of those verbs.
 *
 * It is still an AST walk and not a grep: a definer call named in a COMMENT or
 * in prose must not count as calling it, and only real string, template and
 * no-substitution literals are visited.
 */
export const scanSqlLiterals = (relativeFile: string, source: string, pattern: RegExp): WriterHit[] => {
  const sf = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true);
  const hits: WriterHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf);
      if (pattern.test(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const symbol = enclosingSymbol(node, sf);
        hits.push({
          file: relativeFile,
          line: line + 1,
          kind: 'RAWSQL',
          symbol,
          detail: text.slice(0, 120).replace(/\s+/g, ' '),
          key: `${relativeFile}::${symbol}::RAWSQL`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
};

export const scanTree = (namePattern: RegExp, sqlPattern: RegExp, root: string = SRC_ROOT): WriterHit[] =>
  productionFiles(root).flatMap((file) =>
    scanSource(path.relative(root, file), fs.readFileSync(file, 'utf8'), namePattern, sqlPattern),
  );
