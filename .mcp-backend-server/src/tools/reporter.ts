import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BACKEND_ROOT } from '../utils/paths.js';
import { jsonResult, runFile, safeHandler } from '../utils/process.js';
import { appliedPatches } from './patcher.js';

const REPORT_FILE = 'AUDITORIA_BACKEND.md';

const LAYERS = ['Controller', 'Service/Lógica', 'ORM/DB', 'Autenticación/Middleware', 'Config/Env'] as const;

const bugSchema = z.object({
  id: z
    .string()
    .regex(/^BUG-BE-\d{2,}$/, 'Formato esperado: BUG-BE-01')
    .optional()
    .describe('Si se omite se asigna secuencialmente (BUG-BE-01, BUG-BE-02…).'),
  title: z.string().min(3).max(200).optional().describe('Título corto del bug.'),
  severity: z.enum(['Crítica', 'Alta', 'Media', 'Baja']).optional().default('Media'),
  layer: z.enum(LAYERS),
  file_and_line: z.string().min(1).max(500).describe('Ej. src/groups/groups.controller.ts:42'),
  symptom: z.string().min(3).max(4_000).describe('Qué fallaba: test roto, error 500, crash al consultar DB…'),
  root_cause: z.string().min(3).max(6_000),
  fix_applied: z.string().min(1).max(6_000),
  verification_status: z.enum(['PASS', 'FAIL', 'PENDIENTE']),
});

type Bug = z.infer<typeof bugSchema> & { id: string };

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function block(text: string): string {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

async function gitInfo(): Promise<{ branch: string; commit: string }> {
  const [branch, commit] = await Promise.all([runFile('git', ['rev-parse', '--abbrev-ref', 'HEAD']), runFile('git', ['rev-parse', '--short', 'HEAD'])]);
  return { branch: branch.stdout.trim() || 'desconocida', commit: commit.stdout.trim() || 'desconocido' };
}

function renderReport(bugs: Bug[], meta: { title: string; summary?: string; auditor?: string; branch: string; commit: string }): string {
  const now = new Date();
  const pass = bugs.filter((b) => b.verification_status === 'PASS').length;
  const fail = bugs.filter((b) => b.verification_status === 'FAIL').length;
  const pending = bugs.length - pass - fail;
  const byLayer = LAYERS.map((l) => [l, bugs.filter((b) => b.layer === l).length] as const).filter(([, n]) => n > 0);

  const lines: string[] = [];
  lines.push(`# ${meta.title}`, '');
  lines.push(`- **Fecha:** ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  lines.push(`- **Rama / commit:** \`${meta.branch}\` @ \`${meta.commit}\``);
  lines.push(`- **Generado por:** ${meta.auditor ?? 'backend-qa-server (MCP)'}`);
  lines.push(`- **Bugs reportados:** ${bugs.length} — ✅ PASS: ${pass} · ❌ FAIL: ${fail} · ⏳ Pendientes: ${pending}`, '');
  if (meta.summary) lines.push('## Resumen ejecutivo', '', meta.summary.trim(), '');

  lines.push('## Tabla de hallazgos', '');
  lines.push('| ID | Severidad | Capa | Ubicación | Síntoma | Verificación |');
  lines.push('|----|-----------|------|-----------|---------|--------------|');
  for (const b of bugs) {
    const icon = b.verification_status === 'PASS' ? '✅ PASS' : b.verification_status === 'FAIL' ? '❌ FAIL' : '⏳ PENDIENTE';
    const symptom = b.symptom.length > 120 ? `${b.symptom.slice(0, 117)}…` : b.symptom;
    lines.push(`| ${b.id} | ${b.severity} | ${cell(b.layer)} | \`${cell(b.file_and_line)}\` | ${cell(symptom)} | ${icon} |`);
  }
  lines.push('');

  if (byLayer.length > 0) {
    lines.push('### Distribución por capa', '');
    for (const [layer, n] of byLayer) lines.push(`- **${layer}:** ${n}`);
    lines.push('');
  }

  lines.push('## Detalle de bugs', '');
  for (const b of bugs) {
    lines.push(`### ${b.id}${b.title ? ` — ${b.title}` : ''}`, '');
    lines.push(`| Campo | Valor |`, `|---|---|`);
    lines.push(`| Capa | ${cell(b.layer)} |`, `| Severidad | ${b.severity} |`, `| Ubicación | \`${cell(b.file_and_line)}\` |`, `| Verificación | **${b.verification_status}** |`, '');
    lines.push('**Síntoma**', '', block(b.symptom), '');
    lines.push('**Causa raíz**', '', block(b.root_cause), '');
    lines.push('**Corrección aplicada**', '', block(b.fix_applied), '');
  }

  if (appliedPatches.length > 0) {
    lines.push('## Parches aplicados en esta sesión (apply_backend_fix)', '');
    lines.push('| Archivo | Fecha | Motivo |', '|---|---|---|');
    for (const p of appliedPatches) lines.push(`| \`${cell(p.file)}\` | ${p.at} | ${cell(p.reason)} |`);
    lines.push('');
  }

  lines.push('---', '', '_Reporte generado automáticamente por la herramienta `generate_backend_bug_report` del servidor MCP backend-qa._', '');
  return lines.join('\n');
}

export function registerReporterTools(server: McpServer): void {
  server.registerTool(
    'generate_backend_bug_report',
    {
      title: 'Generar reporte de bugs',
      description:
        `Genera ${REPORT_FILE} en la raíz del backend con la lista estructurada de bugs (id BUG-BE-NN, capa, archivo:línea, síntoma, causa raíz, ` +
        'corrección y estado de verificación tras run_backend_tests). Incluye tabla resumen, distribución por capa y los parches aplicados en la sesión. Sobrescribe el archivo existente.',
      inputSchema: {
        bugs: z.array(bugSchema).min(1).max(200),
        report_title: z.string().min(3).max(200).optional().default('Auditoría de Backend'),
        executive_summary: z.string().max(10_000).optional().describe('Resumen ejecutivo en Markdown.'),
        auditor: z.string().max(200).optional(),
      },
    },
    safeHandler('generate_backend_bug_report', async ({ bugs, report_title, executive_summary, auditor }) => {
      const used = new Set<string>();
      let seq = 0;
      const normalized: Bug[] = bugs.map((b) => {
        let id = b.id;
        if (!id || used.has(id)) {
          do {
            seq++;
            id = `BUG-BE-${String(seq).padStart(2, '0')}`;
          } while (used.has(id));
        }
        used.add(id);
        return { ...b, id, severity: b.severity ?? 'Media' };
      });
      normalized.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

      const { branch, commit } = await gitInfo();
      const markdown = renderReport(normalized, { title: report_title ?? 'Auditoría de Backend', summary: executive_summary, auditor, branch, commit });
      const target = path.join(BACKEND_ROOT, REPORT_FILE);
      const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, markdown, 'utf8');
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
      return jsonResult({
        file: REPORT_FILE,
        path: target,
        bugs: normalized.length,
        verification: {
          PASS: normalized.filter((b) => b.verification_status === 'PASS').length,
          FAIL: normalized.filter((b) => b.verification_status === 'FAIL').length,
          PENDIENTE: normalized.filter((b) => b.verification_status === 'PENDIENTE').length,
        },
        ids: normalized.map((b) => b.id),
      });
    }),
  );
}
