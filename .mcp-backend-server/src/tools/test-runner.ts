import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BACKEND_ROOT, toBackendRelative } from '../utils/paths.js';
import { errorResult, jsonResult, resolveBackendBin, runFile, runNodeScript, safeHandler, stripAnsi, truncate, type RunResult } from '../utils/process.js';

type Framework = 'jest' | 'vitest' | 'mocha' | 'node-test';

interface BackendPackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  jest?: unknown;
  eslintConfig?: unknown;
}

export interface FailureLocation {
  file: string;
  line: number;
  column: number;
}

export interface ParsedFailure {
  suite: string;
  test: string;
  expected?: string;
  received?: string;
  message: string;
  location?: FailureLocation;
  stack: string;
}

export interface TestRunSummary {
  framework: Framework | 'none';
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  passed: boolean;
  totals: { suites: number; failedSuites: number; tests: number; passedTests: number; failedTests: number; skippedTests: number };
  noTestsFound: boolean;
  suiteErrors: Array<{ suite: string; message: string; location?: FailureLocation }>;
  failures: ParsedFailure[];
  notes: string[];
  rawOutput?: string;
}

export function readBackendPackageJson(): BackendPackageJson {
  const file = path.join(BACKEND_ROOT, 'package.json');
  if (!existsSync(file)) throw new Error(`No existe package.json en ${BACKEND_ROOT}`);
  return JSON.parse(readFileSync(file, 'utf8')) as BackendPackageJson;
}

function hasDep(pkg: BackendPackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

export function detectTestFramework(pkg: BackendPackageJson): Framework | null {
  const testScript = pkg.scripts?.test ?? '';
  if (/\bvitest\b/.test(testScript) || (hasDep(pkg, 'vitest') && !/\bjest\b/.test(testScript))) return 'vitest';
  if (/\bjest\b/.test(testScript) || hasDep(pkg, 'jest')) return 'jest';
  if (/\bmocha\b/.test(testScript) || hasDep(pkg, 'mocha')) return 'mocha';
  if (/node\s+(--[\w-]+\s+)*--test/.test(testScript)) return 'node-test';
  return null;
}

const STACK_FRAME_RE = /(?:\(|\bat\s+|^\s*)((?:[A-Za-z]:)?[^\s():]+\.(?:ts|tsx|js|mjs|cjs|mts|cts)):(\d+):(\d+)/gm;

/** Primer frame del stack que pertenece al código del backend (no node_modules ni internos de Node). */
export function extractLocation(text: string): FailureLocation | undefined {
  for (const match of text.matchAll(STACK_FRAME_RE)) {
    const file = match[1];
    if (!file || file.includes('node_modules') || file.startsWith('node:') || file.startsWith('internal/')) continue;
    const abs = path.isAbsolute(file) ? file : path.resolve(BACKEND_ROOT, file);
    return { file: abs.startsWith(BACKEND_ROOT) ? toBackendRelative(abs) : file, line: Number(match[2]), column: Number(match[3]) };
  }
  return undefined;
}

function extractExpectedReceived(text: string): { expected?: string; received?: string } {
  const expected = /^\s*Expected(?: value)?(?: \(.*?\))?:\s*(.+)$/m.exec(text)?.[1];
  const received = /^\s*Received(?: value)?(?: \(.*?\))?:\s*(.+)$/m.exec(text)?.[1];
  if (expected || received) return { expected: expected?.trim(), received: received?.trim() };
  // Formato chai / assert: "expected X to equal Y"
  const chai = /expected\s+(.+?)\s+to\s+(?:deeply\s+)?(?:equal|be|eql|strictly equal)\s+(.+)$/im.exec(text);
  if (chai) return { received: chai[1]?.trim(), expected: chai[2]?.trim() };
  return {};
}

function firstMeaningfulLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('at ')) ?? text.slice(0, 300);
}

function buildFailure(suite: string, test: string, rawMessage: string): ParsedFailure {
  const clean = stripAnsi(rawMessage);
  const stackStart = clean.search(/^\s+at\s/m);
  return {
    suite,
    test,
    ...extractExpectedReceived(clean),
    message: truncate(stackStart > 0 ? clean.slice(0, stackStart).trim() : firstMeaningfulLine(clean), 3_000),
    location: extractLocation(clean),
    stack: truncate(stackStart > 0 ? clean.slice(stackStart).trim() : clean, 3_000),
  };
}

// ---- Parsers por framework ----

interface JestJsonReport {
  numTotalTestSuites?: number;
  numFailedTestSuites?: number;
  numRuntimeErrorTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  success?: boolean;
  testResults?: Array<{
    name: string;
    status?: string;
    message?: string;
    failureMessage?: string | null;
    assertionResults?: Array<{ ancestorTitles?: string[]; title: string; fullName?: string; status: string; failureMessages?: string[] }>;
  }>;
}

function parseJestLikeReport(report: JestJsonReport, summary: TestRunSummary): void {
  summary.totals = {
    suites: report.numTotalTestSuites ?? 0,
    failedSuites: (report.numFailedTestSuites ?? 0) + (report.numRuntimeErrorTestSuites ?? 0),
    tests: report.numTotalTests ?? 0,
    passedTests: report.numPassedTests ?? 0,
    failedTests: report.numFailedTests ?? 0,
    skippedTests: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
  };
  for (const suite of report.testResults ?? []) {
    const suiteName = path.isAbsolute(suite.name) ? toBackendRelative(suite.name) : suite.name;
    const assertions = suite.assertionResults ?? [];
    const suiteMessage = suite.failureMessage ?? suite.message ?? '';
    if (suite.status === 'failed' && assertions.length === 0 && suiteMessage.trim() !== '') {
      const clean = stripAnsi(suiteMessage);
      summary.suiteErrors.push({ suite: suiteName, message: truncate(clean, 4_000), location: extractLocation(clean) });
    }
    for (const assertion of assertions) {
      if (assertion.status !== 'failed') continue;
      const testName = [...(assertion.ancestorTitles ?? []), assertion.title].join(' › ');
      summary.failures.push(buildFailure(suiteName, testName, (assertion.failureMessages ?? []).join('\n')));
    }
  }
}

interface MochaJsonReport {
  stats?: { suites?: number; tests?: number; passes?: number; failures?: number; pending?: number };
  failures?: Array<{ title: string; fullTitle?: string; file?: string; err?: { message?: string; stack?: string; expected?: unknown; actual?: unknown } }>;
}

function parseMochaReport(report: MochaJsonReport, summary: TestRunSummary): void {
  summary.totals = {
    suites: report.stats?.suites ?? 0,
    failedSuites: 0,
    tests: report.stats?.tests ?? 0,
    passedTests: report.stats?.passes ?? 0,
    failedTests: report.stats?.failures ?? 0,
    skippedTests: report.stats?.pending ?? 0,
  };
  for (const failure of report.failures ?? []) {
    const parsed = buildFailure(failure.file ? toBackendRelative(failure.file) : '(desconocido)', failure.fullTitle ?? failure.title, `${failure.err?.message ?? ''}\n${failure.err?.stack ?? ''}`);
    if (failure.err?.expected !== undefined) parsed.expected = JSON.stringify(failure.err.expected);
    if (failure.err?.actual !== undefined) parsed.received = JSON.stringify(failure.err.actual);
    summary.failures.push(parsed);
  }
}

function parseNodeTestOutput(output: string, summary: TestRunSummary): void {
  const clean = stripAnsi(output);
  const num = (label: string): number => Number(new RegExp(`^# ${label} (\\d+)`, 'm').exec(clean)?.[1] ?? 0);
  summary.totals = { suites: num('suites'), failedSuites: 0, tests: num('tests'), passedTests: num('pass'), failedTests: num('fail'), skippedTests: num('skipped') + num('todo') };
  const blocks = clean.split(/^(?=\s*not ok \d+ - )/m).slice(1);
  for (const block of blocks) {
    const title = /not ok \d+ - (.+)/.exec(block)?.[1]?.trim() ?? '(desconocido)';
    const file = /location: '([^']+)'/.exec(block)?.[1] ?? '';
    summary.failures.push(buildFailure(file, title, block));
  }
}

/** Fallback cuando no hay reporte JSON: detecta los bloques "●" de Jest en la salida de texto. */
function parseJestTextOutput(output: string, summary: TestRunSummary): void {
  const clean = stripAnsi(output);
  for (const block of clean.split(/^\s*● /m).slice(1)) {
    const [header = '', ...rest] = block.split('\n');
    const [suite, ...testParts] = header.split(' › ');
    summary.failures.push(buildFailure(suite?.trim() ?? '', testParts.join(' › ').trim() || header.trim(), rest.join('\n')));
  }
}

// ---- Ejecución ----

async function runTests(testPattern: string | undefined, updateSnapshots: boolean): Promise<TestRunSummary> {
  const pkg = readBackendPackageJson();
  const framework = detectTestFramework(pkg);
  const summary: TestRunSummary = {
    framework: framework ?? 'none',
    command: '',
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    passed: false,
    totals: { suites: 0, failedSuites: 0, tests: 0, passedTests: 0, failedTests: 0, skippedTests: 0 },
    noTestsFound: false,
    suiteErrors: [],
    failures: [],
    notes: [],
  };
  if (!framework) {
    summary.notes.push('No se detectó framework de pruebas (jest, vitest, mocha o node --test) en package.json.');
    return summary;
  }

  const reportFile = path.join(tmpdir(), `backend-qa-${process.pid}-${Date.now()}.json`);
  let run: RunResult;
  try {
    if (framework === 'jest') {
      const bin = resolveBackendBin('jest');
      if (!bin) throw new Error('jest está declarado pero no instalado en node_modules del backend (ejecuta npm install).');
      const args = ['--ci', '--json', `--outputFile=${reportFile}`, '--testLocationInResults'];
      if (updateSnapshots) args.push('--updateSnapshot');
      // Patrón posicional: compatible con Jest 29 (--testPathPattern) y Jest 30 (--testPathPatterns).
      if (testPattern) args.push(testPattern);
      run = await runNodeScript(bin, args);
    } else if (framework === 'vitest') {
      const bin = resolveBackendBin('vitest');
      if (!bin) throw new Error('vitest está declarado pero no instalado en node_modules del backend.');
      const args = ['run', '--reporter=json', `--outputFile=${reportFile}`];
      if (updateSnapshots) args.push('--update');
      if (testPattern) args.push(testPattern);
      run = await runNodeScript(bin, args);
    } else if (framework === 'mocha') {
      const bin = resolveBackendBin('mocha');
      if (!bin) throw new Error('mocha está declarado pero no instalado en node_modules del backend.');
      const args = ['--reporter', 'json', '--reporter-option', `output=${reportFile}`];
      if (testPattern) args.push('--grep', testPattern);
      run = await runNodeScript(bin, args);
    } else {
      const args = ['--test', '--test-reporter=tap'];
      if (testPattern) args.push('--test-name-pattern', testPattern);
      run = await runFile(process.execPath, args);
    }

    summary.command = [path.basename(run.command), ...run.args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a))].join(' ');
    summary.exitCode = run.exitCode;
    summary.timedOut = run.timedOut;
    summary.durationMs = run.durationMs;
    if (run.spawnError) summary.notes.push(`Error al lanzar el proceso: ${run.spawnError}`);
    if (run.timedOut) summary.notes.push('La suite superó el timeout de 120 s y fue terminada.');

    const combined = `${run.stdout}\n${run.stderr}`;
    let parsedJson = false;
    if (existsSync(reportFile)) {
      try {
        const report: unknown = JSON.parse(readFileSync(reportFile, 'utf8'));
        if (framework === 'mocha') parseMochaReport(report as MochaJsonReport, summary);
        else parseJestLikeReport(report as JestJsonReport, summary);
        parsedJson = true;
      } catch (error) {
        summary.notes.push(`No se pudo parsear el reporte JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!parsedJson) {
      if (framework === 'node-test') parseNodeTestOutput(combined, summary);
      else parseJestTextOutput(combined, summary);
    }

    summary.noTestsFound = /No tests found|No test files found|0 passing|# tests 0/i.test(combined) || (parsedJson && summary.totals.tests === 0 && summary.totals.suites === 0);
    if (summary.noTestsFound) {
      summary.notes.push('No se encontró ningún archivo de prueba (*.spec.ts / *.test.ts). El backend no tiene cobertura automatizada.');
    }
    summary.passed = run.exitCode === 0 && summary.failures.length === 0 && summary.suiteErrors.length === 0 && !summary.noTestsFound;
    if (!summary.passed || !parsedJson) summary.rawOutput = truncate(stripAnsi(combined), 12_000);
  } finally {
    rmSync(reportFile, { force: true });
  }
  return summary;
}

// ---- Typecheck y linter ----

interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+(?:\n(?!\S.*\(\d+,\d+\):).+)*)/gm;
  for (const match of stripAnsi(output).matchAll(re)) {
    diagnostics.push({ file: match[1] ?? '', line: Number(match[2]), column: Number(match[3]), code: match[4] ?? '', message: (match[5] ?? '').trim() });
  }
  return diagnostics;
}

const ESLINT_CONFIG_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

interface EslintFileResult {
  filePath: string;
  messages: Array<{ ruleId: string | null; severity: number; message: string; line?: number; column?: number }>;
}

async function runLinterAndTypecheck(tsconfig: string, includeLint: boolean): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  const tscBin = resolveBackendBin('typescript', 'tsc');
  const tsconfigPath = path.join(BACKEND_ROOT, tsconfig);
  if (!tscBin) {
    result.typecheck = { skipped: true, reason: 'typescript no está instalado en node_modules del backend.' };
  } else if (!existsSync(tsconfigPath)) {
    result.typecheck = { skipped: true, reason: `No existe ${tsconfig} en el backend.` };
  } else {
    const run = await runNodeScript(tscBin, ['--noEmit', '--pretty', 'false', '--incremental', 'false', '-p', tsconfigPath]);
    const diagnostics = parseTscOutput(`${run.stdout}\n${run.stderr}`);
    result.typecheck = {
      command: `tsc --noEmit -p ${tsconfig}`,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      passed: run.exitCode === 0,
      errorCount: diagnostics.length,
      diagnostics,
      ...(run.exitCode !== 0 && diagnostics.length === 0 ? { rawOutput: truncate(stripAnsi(`${run.stdout}\n${run.stderr}`), 8_000) } : {}),
      ...(run.spawnError ? { spawnError: run.spawnError } : {}),
    };
  }

  if (!includeLint) return result;
  const pkg = readBackendPackageJson();
  const eslintBin = resolveBackendBin('eslint');
  const configFile = ESLINT_CONFIG_FILES.find((f) => existsSync(path.join(BACKEND_ROOT, f)));
  if (!eslintBin) {
    result.lint = { skipped: true, reason: 'eslint no está instalado en el backend.' };
  } else if (!configFile && !pkg.eslintConfig) {
    result.lint = {
      skipped: true,
      reason: 'eslint está instalado pero no existe ningún archivo de configuración (eslint.config.* / .eslintrc*). El script "npm run lint" del backend fallará.',
    };
  } else {
    const targets = ['src', 'test'].filter((d) => existsSync(path.join(BACKEND_ROOT, d)));
    // Sin --fix: la auditoría nunca modifica archivos por su cuenta.
    const run = await runNodeScript(eslintBin, ['--format', 'json', ...targets]);
    try {
      const files = JSON.parse(run.stdout) as EslintFileResult[];
      const problems = files.flatMap((f) =>
        f.messages.map((m) => ({ file: toBackendRelative(f.filePath), line: m.line ?? 0, column: m.column ?? 0, rule: m.ruleId, severity: m.severity === 2 ? 'error' : 'warning', message: m.message })),
      );
      result.lint = {
        command: `eslint --format json ${targets.join(' ')}`,
        config: configFile ?? 'package.json#eslintConfig',
        exitCode: run.exitCode,
        errorCount: problems.filter((p) => p.severity === 'error').length,
        warningCount: problems.filter((p) => p.severity === 'warning').length,
        problems: problems.slice(0, 300),
      };
    } catch {
      result.lint = { exitCode: run.exitCode, parseError: 'La salida de eslint no es JSON válido.', rawOutput: truncate(stripAnsi(`${run.stdout}\n${run.stderr}`), 8_000) };
    }
  }
  return result;
}

export function registerTestRunnerTools(server: McpServer): void {
  server.registerTool(
    'run_backend_tests',
    {
      title: 'Ejecutar pruebas del backend',
      description:
        'Detecta el framework de pruebas del backend (jest, vitest, mocha o node --test) y ejecuta la suite en el directorio padre. ' +
        'Devuelve totales y, por cada fallo: suite, nombre de la prueba, valor esperado vs recibido, mensaje y ubicación exacta (archivo:línea) del stack.',
      inputSchema: {
        test_pattern: z.string().min(1).max(500).optional().describe('Filtro opcional: patrón de ruta de archivo (jest/vitest) o de nombre de prueba (mocha/node).'),
        update_snapshots: z.boolean().optional().default(false).describe('Actualiza snapshots (jest -u / vitest --update).'),
      },
    },
    safeHandler('run_backend_tests', async ({ test_pattern, update_snapshots }) => {
      const summary = await runTests(test_pattern, update_snapshots ?? false);
      if (summary.framework === 'none') return errorResult('No se pudo ejecutar la suite.', summary);
      return jsonResult(summary);
    }),
  );

  server.registerTool(
    'run_backend_linter_and_typecheck',
    {
      title: 'Typecheck y linter del backend',
      description:
        'Ejecuta "tsc --noEmit" con el tsconfig del backend para capturar errores de tipos en DTOs, controladores y servicios, ' +
        'y el linter configurado (eslint, sin --fix). Devuelve diagnósticos estructurados con archivo, línea y código de error.',
      inputSchema: {
        tsconfig: z.string().min(1).max(200).optional().default('tsconfig.json').describe('Ruta relativa del tsconfig a usar.'),
        include_lint: z.boolean().optional().default(true).describe('Si es false, solo ejecuta el typecheck.'),
      },
    },
    safeHandler('run_backend_linter_and_typecheck', async ({ tsconfig, include_lint }) => {
      if (path.isAbsolute(tsconfig) || tsconfig.includes('..')) return errorResult('tsconfig debe ser una ruta relativa dentro del backend.');
      return jsonResult(await runLinterAndTypecheck(tsconfig, include_lint ?? true));
    }),
  );
}
