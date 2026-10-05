import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveBackendPath, resolveWritableBackendPath, toBackendRelative } from '../utils/paths.js';
import { errorResult, jsonResult, runFile, safeHandler, truncate } from '../utils/process.js';

export interface AppliedPatch {
  file: string;
  reason: string;
  at: string;
  created: boolean;
  bytesBefore: number;
  bytesAfter: number;
}

/** Registro en memoria de los parches de esta sesión (lo usa el reporte). */
export const appliedPatches: AppliedPatch[] = [];

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

async function git(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const run = await runFile('git', args);
  return { ok: run.exitCode === 0, stdout: run.stdout, stderr: run.stderr || run.spawnError || '', exitCode: run.exitCode };
}

async function isTracked(relPath: string): Promise<boolean> {
  return (await git(['ls-files', '--error-unmatch', '--', relPath])).ok;
}

/** Escritura atómica: archivo temporal en el mismo directorio + rename, preservando permisos. */
async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${randomBytes(6).toString('hex')}.tmp`);
  const mode = existsSync(absPath) ? statSync(absPath).mode : undefined;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, absPath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function registerPatcherTools(server: McpServer): void {
  server.registerTool(
    'apply_backend_fix',
    {
      title: 'Aplicar corrección',
      description:
        'Reemplaza el contenido completo de un archivo del backend de forma atómica (temporal + rename). Bloquea Path Traversal y escrituras en ' +
        '.git, node_modules y el propio servidor MCP. Devuelve el git diff resultante. Envía SIEMPRE el archivo completo, no un fragmento.',
      inputSchema: {
        relative_path: z.string().min(1).max(1024).describe('Ruta relativa al backend del archivo a corregir.'),
        new_content: z.string().max(MAX_CONTENT_BYTES).describe('Contenido COMPLETO y final del archivo.'),
        reason: z.string().min(5).max(2_000).describe('Justificación técnica de la corrección (se registra para el reporte).'),
      },
    },
    safeHandler('apply_backend_fix', async ({ relative_path, new_content, reason }) => {
      const abs = resolveWritableBackendPath(relative_path);
      const rel = toBackendRelative(abs);
      const existed = existsSync(abs);
      if (existed && statSync(abs).isDirectory()) return errorResult(`${rel} es un directorio.`);
      const before = existed ? await readFile(abs, 'utf8') : '';
      if (existed && before === new_content) return jsonResult({ file: rel, changed: false, message: 'El contenido es idéntico; no se escribió nada.' });

      // Salvaguarda contra parches truncados accidentalmente (p. ej. "... resto del archivo ...").
      if (existed && before.length > 400 && new_content.length < before.length * 0.3) {
        return errorResult(
          `Parche rechazado: el nuevo contenido (${new_content.length} caracteres) es menos del 30% del original (${before.length}). ` +
            'Parece un fragmento y no el archivo completo. Envía el archivo íntegro.',
        );
      }
      if (/\/\/\s*\.\.\.\s*(resto|rest of|existing code)/i.test(new_content)) {
        return errorResult('Parche rechazado: el contenido contiene un marcador de elisión ("// ... resto ..."). Envía el archivo completo.');
      }

      await atomicWrite(abs, new_content);
      const patch: AppliedPatch = { file: rel, reason, at: new Date().toISOString(), created: !existed, bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(new_content) };
      appliedPatches.push(patch);
      console.error(`[backend-qa] Parche aplicado en ${rel}: ${reason}`);

      const diff = existed ? await git(['diff', '--no-color', '--no-ext-diff', '--', rel]) : { ok: true, stdout: '(archivo nuevo, sin seguimiento en git)', stderr: '', exitCode: 0 };
      return jsonResult({ ...patch, changed: true, diff: truncate(diff.stdout || diff.stderr, 20_000), next: 'Ejecuta run_backend_tests / run_backend_linter_and_typecheck para verificar; si falla, revert_backend_file.' });
    }),
  );

  server.registerTool(
    'git_diff_backend',
    {
      title: 'Ver git diff del backend',
      description: 'Ejecuta git diff en el repositorio del backend (opcionalmente limitado a un archivo, a cambios staged o como resumen --stat) para validar qué se modificó.',
      inputSchema: {
        relative_path: z.string().min(1).max(1024).optional().describe('Limita el diff a este archivo o directorio.'),
        staged: z.boolean().optional().default(false).describe('Mostrar cambios en el índice (--cached).'),
        stat_only: z.boolean().optional().default(false).describe('Solo resumen --stat.'),
      },
    },
    safeHandler('git_diff_backend', async ({ relative_path, staged, stat_only }) => {
      const args = ['diff', '--no-color', '--no-ext-diff'];
      if (staged) args.push('--cached');
      if (stat_only) args.push('--stat');
      if (relative_path) args.push('--', toBackendRelative(resolveBackendPath(relative_path)) || '.');
      const [diff, status] = await Promise.all([git(args), git(['status', '--porcelain=v1', '--untracked-files=normal'])]);
      if (!diff.ok) return errorResult(`git diff falló (exit ${diff.exitCode}): ${diff.stderr}`);
      const untracked = status.stdout.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3));
      return jsonResult({
        command: `git ${args.join(' ')}`,
        empty: diff.stdout.trim() === '',
        diff: truncate(diff.stdout, 60_000),
        untrackedFiles: untracked,
        sessionPatches: appliedPatches,
      });
    }),
  );

  server.registerTool(
    'revert_backend_file',
    {
      title: 'Revertir archivo',
      description:
        'Descarta las modificaciones de un archivo con "git checkout -- <archivo>" (vuelve a la versión del último commit). ' +
        'ATENCIÓN: también descarta cambios sin commitear hechos a mano en ese archivo. Para archivos nuevos sin seguimiento, usa delete_if_untracked.',
      inputSchema: {
        relative_path: z.string().min(1).max(1024),
        delete_if_untracked: z.boolean().optional().default(false).describe('Si el archivo no está en git (creado por un parche), eliminarlo.'),
      },
    },
    safeHandler('revert_backend_file', async ({ relative_path, delete_if_untracked }) => {
      const abs = resolveWritableBackendPath(relative_path);
      const rel = toBackendRelative(abs);
      if (!(await isTracked(rel))) {
        if (!existsSync(abs)) return errorResult(`${rel} no existe ni está en git.`);
        if (!delete_if_untracked) return errorResult(`${rel} no está bajo control de versiones; git checkout no puede restaurarlo. Repite con delete_if_untracked: true para eliminarlo.`);
        await rm(abs, { force: true });
        return jsonResult({ file: rel, reverted: true, action: 'deleted-untracked-file' });
      }
      const preview = await git(['diff', '--no-color', '--stat', '--', rel]);
      const result = await git(['checkout', '--', rel]);
      if (!result.ok) return errorResult(`git checkout falló: ${result.stderr}`);
      for (let i = appliedPatches.length - 1; i >= 0; i--) if (appliedPatches[i]?.file === rel) appliedPatches.splice(i, 1);
      console.error(`[backend-qa] Archivo revertido: ${rel}`);
      return jsonResult({ file: rel, reverted: true, action: 'git checkout --', discardedChanges: preview.stdout.trim() || '(sin cambios pendientes)' });
    }),
  );
}
