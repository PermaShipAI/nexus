#!/usr/bin/env tsx
/**
 * enforce-deferral.ts
 *
 * AST-based static analysis gate: every async Discord.js interaction handler
 * (any async function/method/arrow-function whose first parameter is typed as
 * a Discord.js Interaction subtype) must call
 *   await <param>.deferReply(...)  OR  await <param>.deferUpdate(...)
 * as its FIRST `await` expression.
 *
 * Synchronous operations that precede the first `await` (e.g. RBAC preflight
 * checks) are allowed.  Nested function boundaries are not crossed.
 *
 * Exits 0 when no violations are found; exits 1 and prints each violation
 * as  <file>:<line>:<col>  <message>.
 *
 * Usage:
 *   npx tsx scripts/enforce-deferral.ts
 */

import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// ─── Discord.js Interaction type names that require deferral ─────────────────
const INTERACTION_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Interaction',
  'CommandInteraction',
  'ChatInputCommandInteraction',
  'ContextMenuCommandInteraction',
  'MessageContextMenuCommandInteraction',
  'UserContextMenuCommandInteraction',
  'ButtonInteraction',
  'StringSelectMenuInteraction',
  'SelectMenuInteraction',
  'AnySelectMenuInteraction',
  'ModalSubmitInteraction',
  'AutocompleteInteraction',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Violation {
  file: string;
  line: number;
  column: number;
  message: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect .ts source files (excluding test files) in a directory. */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files; // directory does not exist — not an error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Returns true when the type node text references a known Discord Interaction
 * subtype (e.g. `ChatInputCommandInteraction`, `ButtonInteraction`, …).
 */
function isInteractionTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  const text = typeNode.getText();
  return [...INTERACTION_TYPE_NAMES].some((name) => text.includes(name));
}

/**
 * Collect all AwaitExpression nodes within `root`, but do NOT descend into
 * nested function declarations, function expressions, arrow functions, or
 * method declarations — those are separate handler scopes.
 */
function collectAwaits(root: ts.Node): ts.AwaitExpression[] {
  const awaits: ts.AwaitExpression[] = [];

  function walk(node: ts.Node): void {
    if (ts.isAwaitExpression(node)) {
      awaits.push(node);
      // Do not descend further — we have the outermost await.
      return;
    }
    // Stop at nested function boundaries (they are separate handlers).
    if (
      node !== root &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    ts.forEachChild(node, walk);
  }

  walk(root);
  return awaits;
}

/**
 * Returns true when `expr` is `await <paramName>.deferReply(...)`
 * or `await <paramName>.deferUpdate(...)`.
 */
function isDeferralCall(expr: ts.AwaitExpression, paramName: string): boolean {
  const inner = expr.expression;
  if (!ts.isCallExpression(inner)) return false;
  const callee = inner.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const obj = callee.expression;
  const method = callee.name.text;
  return (
    ts.isIdentifier(obj) &&
    obj.text === paramName &&
    (method === 'deferReply' || method === 'deferUpdate')
  );
}

/** Derive a display name for the function-like node (best-effort). */
function getFuncName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return '<anonymous>';
}

// ─── Core analysis ───────────────────────────────────────────────────────────

/**
 * Analyse one function-like node for deferral compliance.
 * Pushes a Violation if the rule is broken.
 */
function analyzeFunctionLike(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: Violation[],
): void {
  // Rule only applies to async functions.
  const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (!isAsync) return;

  // Must have a block body.
  if (!node.body || !ts.isBlock(node.body)) return;

  // Find the first parameter typed as a Discord Interaction.
  const interactionParam = node.parameters.find((p) => isInteractionTypeNode(p.type));
  if (!interactionParam) return;

  // Parameter must be a simple identifier (not destructuring).
  if (!ts.isIdentifier(interactionParam.name)) return;
  const paramName = interactionParam.name.text;

  // Collect and sort all await expressions by source position.
  const awaits = collectAwaits(node.body).sort(
    (a, b) => a.getStart(sourceFile) - b.getStart(sourceFile),
  );

  // No awaits → function is effectively synchronous; no deferral required.
  if (awaits.length === 0) return;

  // The FIRST await must be a deferral call on the interaction parameter.
  const firstAwait = awaits[0];
  if (!isDeferralCall(firstAwait, paramName)) {
    const pos = sourceFile.getLineAndCharacterOfPosition(firstAwait.getStart(sourceFile));
    const funcName = getFuncName(node);
    violations.push({
      file: filePath,
      line: pos.line + 1,
      column: pos.character + 1,
      message:
        `Function '${funcName}' with '${paramName}: Interaction' parameter must call ` +
        `\`await ${paramName}.deferReply()\` or \`await ${paramName}.deferUpdate()\` ` +
        `as its first async operation (found non-deferral await at line ${pos.line + 1}).`,
    });
  }
}

/**
 * Analyse a TypeScript source file (by path, or by providing source text
 * directly — useful in tests).
 *
 * @param filePath  Used as the file identifier in violation messages.
 * @param source    Optional source text; if omitted the file is read from disk.
 */
export function analyzeFile(filePath: string, source?: string): Violation[] {
  const sourceCode = source ?? readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  );

  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      analyzeFunctionLike(node as ts.FunctionLikeDeclaration, sourceFile, filePath, violations);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scanDirs = [join(PROJECT_ROOT, 'src', 'integrations', 'discord')];

  const allFiles: string[] = [];
  for (const dir of scanDirs) {
    allFiles.push(...collectTsFiles(dir));
  }

  if (allFiles.length === 0) {
    console.log('deferral-check: no Discord handler files found — nothing to check.');
    process.exit(0);
  }

  const allViolations: Violation[] = [];
  for (const file of allFiles) {
    const violations = analyzeFile(file);
    allViolations.push(...violations);
  }

  const scanned = allFiles.length;

  if (allViolations.length === 0) {
    console.log(`deferral-check: ${scanned} file(s) scanned, 0 violations. ✓`);
    process.exit(0);
  }

  process.stderr.write(
    `\ndeferral-check: ${allViolations.length} violation(s) in ${scanned} file(s):\n\n`,
  );
  for (const v of allViolations) {
    const rel = relative(PROJECT_ROOT, v.file);
    process.stderr.write(`  ${rel}:${v.line}:${v.column}  ${v.message}\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

// Only execute when this file is the entry point, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`deferral-check: fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
