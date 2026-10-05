import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BACKEND_ROOT } from './paths.js';

export const MAX_BUFFER = 15 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ejecuta un binario con execFile (sin shell, argumentos en array). Nunca lanza:
 * los fallos de proceso se devuelven en el resultado para que la herramienta los reporte.
 */
export function runFile(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? BACKEND_ROOT,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const result: RunResult = {
          command,
          args,
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - started,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        };
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
          result.exitCode = typeof err.code === 'number' ? err.code : null;
          result.signal = err.signal ?? null;
          result.timedOut = Boolean(err.killed) && err.signal === 'SIGTERM';
          if (typeof err.code === 'string') {
            result.spawnError = `${err.code}: ${err.message}`;
          } else if (err.message.includes('maxBuffer')) {
            result.spawnError = `Salida mayor a ${MAX_BUFFER} bytes: ${err.message}`;
          }
        }
        resolve(result);
      },
    );
  });
}

/** Ejecuta un script JS con el mismo binario de Node que corre el servidor. */
export function runNodeScript(scriptPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runFile(process.execPath, [scriptPath, ...args], options);
}

/**
 * Resuelve de forma determinista el entrypoint JS de un binario instalado en el backend:
 * primero el campo "bin" del package.json del paquete, luego el symlink de node_modules/.bin.
 */
export function resolveBackendBin(packageName: string, binName: string = packageName): string | null {
  const pkgDir = path.join(BACKEND_ROOT, 'node_modules', packageName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
      if (rel) {
        const entry = path.join(pkgDir, rel);
        if (existsSync(entry)) return entry;
      }
    } catch (error) {
      console.error(`[backend-qa] No se pudo leer ${pkgJsonPath}:`, error);
    }
  }
  const shim = path.join(BACKEND_ROOT, 'node_modules', '.bin', binName);
  if (existsSync(shim)) {
    try {
      return realpathSync(shim);
    } catch {
      return null;
    }
  }
  return null;
}

/** Recorta textos largos para no saturar la respuesta MCP. */
export function truncate(text: string, maxChars = 20_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.4));
  const tail = text.slice(-Math.floor(maxChars * 0.6));
  return `${head}\n\n… [${text.length - maxChars} caracteres omitidos] …\n\n${tail}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

// ---- Helpers de respuesta para herramientas MCP ----

export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function errorResult(message: string, details?: unknown): CallToolResult {
  const text = details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Envuelve un handler para que cualquier excepción se devuelva como error MCP y se registre en stderr. */
export function safeHandler<A>(toolName: string, handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[backend-qa] Error en ${toolName}:`, error);
      return errorResult(`Fallo en ${toolName}: ${message}`);
    }
  };
}
