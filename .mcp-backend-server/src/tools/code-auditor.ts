import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readBackendDotEnv } from '../utils/db-connection.js';
import { BACKEND_ROOT, resolveBackendPath, toBackendRelative } from '../utils/paths.js';
import { errorResult, jsonResult, safeHandler } from '../utils/process.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.mcp-backend-server']);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/;

/** Lista recursiva de archivos fuente bajo un directorio, omitiendo artefactos de build y dependencias. */
export function listSourceFiles(dir: string, filter: RegExp = SOURCE_EXT): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(current, entry.name));
      } else if (entry.isFile() && filter.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Reemplaza comentarios y contenido de strings por espacios conservando saltos de línea
 * y offsets, para que los análisis por regex no den falsos positivos dentro de textos.
 */
export function maskCommentsAndStrings(src: string): string {
  const chars = src.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return chars.join('');
}

/** Devuelve el índice de la llave de cierre que corresponde a la llave abierta en openIdx (sobre texto enmascarado). */
export function findMatchingBrace(masked: string, openIdx: number, open = '{', close = '}'): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

type Severity = 'critical' | 'high' | 'medium' | 'low';

interface AuditFinding {
  file: string;
  line: number;
  rule: string;
  severity: Severity;
  message: string;
  snippet: string;
}

const PROMISE_METHODS =
  'save|create|insertMany|insertOne|updateOne|updateMany|deleteOne|deleteMany|findByIdAndUpdate|findByIdAndDelete|findOneAndUpdate|findOneAndDelete|replaceOne|bulkWrite|remove|delete|update|upsert|commitTransaction|abortTransaction|endSession|startTransaction|withTransaction|sendMail|send|emit|publish|hash|compare';

function auditSource(relFile: string, src: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const masked = maskCommentsAndStrings(src);
  const lines = src.split('\n');
  const maskedLines = masked.split('\n');
  const isController = /\.controller\.ts$/.test(relFile) || /@Controller\(/.test(masked);
  const add = (index: number, rule: string, severity: Severity, message: string): void => {
    const line = lineOf(src, index);
    findings.push({ file: relFile, line, rule, severity, message, snippet: (lines[line - 1] ?? '').trim().slice(0, 240) });
  };

  // 1. Bloques catch: vacíos, que solo registran, o que devuelven en lugar de propagar.
  for (const match of masked.matchAll(/\bcatch\s*(\(([^)]*)\))?\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = findMatchingBrace(masked, open);
    if (close === -1) continue;
    const body = masked.slice(open + 1, close);
    const errVar = match[2]?.split(':')[0]?.trim();
    if (body.trim() === '') {
      add(match.index ?? 0, 'empty-catch', 'high', 'Bloque catch vacío: el error se traga silenciosamente y el cliente recibe una respuesta engañosa.');
      continue;
    }
    const rethrows = /\bthrow\b/.test(body);
    const returns = /\breturn\b/.test(body);
    const onlyLogs = !rethrows && !returns && /^\s*(?:(?:console|this\.logger|logger)\.\w+\([^;]*\);?\s*)+$/.test(body);
    if (onlyLogs) {
      add(match.index ?? 0, 'swallowed-error', 'high', 'El catch solo registra el error y continúa: la excepción no se propaga y la ejecución sigue con estado inválido.');
    } else if (!rethrows && returns && /\breturn\s+(?:null|undefined|false|\[\]|\{\s*\}|;)/.test(body)) {
      add(match.index ?? 0, 'error-masked-as-value', 'medium', 'El catch devuelve un valor vacío/null en lugar de propagar: el llamador no distingue "no encontrado" de "falló".');
    } else if (rethrows && errVar && /\bthrow\s+new\s+\w*(Error|Exception)\(/.test(body) && !new RegExp(`\\b${errVar}\\b`).test(body.replace(/\bthrow\b[\s\S]*$/, ''))) {
      const throwExpr = /\bthrow\s+new\s+[^;]+/.exec(body)?.[0] ?? '';
      if (!new RegExp(`\\b${errVar}\\b`).test(throwExpr)) {
        add(match.index ?? 0, 'lost-error-cause', 'low', `Se relanza una excepción nueva sin conservar el error original (${errVar}): se pierde la causa raíz en los logs.`);
      }
    }
  }

  // 2. .then() sin .catch() en la misma cadena.
  for (const match of masked.matchAll(/\.then\s*\(/g)) {
    const idx = match.index ?? 0;
    const stmtEnd = masked.indexOf(';', idx);
    const chain = masked.slice(idx, stmtEnd === -1 ? undefined : stmtEnd);
    // Inicio de la sentencia: último ';', '{' o '}' antes del .then() (la cadena puede abarcar varias líneas).
    let stmtStart = 0;
    let depth = 0;
    for (let k = idx - 1; k >= 0; k--) {
      const ch = masked[k];
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if (ch === '(' || ch === '[' || ch === '{') {
        if (depth === 0) {
          stmtStart = k + 1;
          break;
        }
        depth--;
      } else if (ch === ';' && depth === 0) {
        stmtStart = k + 1;
        break;
      }
    }
    const before = masked.slice(stmtStart, idx);
    if (!/\.catch\s*\(/.test(chain) && !/\b(return|await|yield)\b|=(?!=|>)/.test(before)) {
      add(idx, 'unhandled-then', 'medium', '.then() sin .catch() ni await/return: un rechazo produce UnhandledPromiseRejection y puede tumbar el proceso.');
    }
  }

  // 3. Llamadas asíncronas típicas sin await/return/asignación (fire-and-forget).
  const floatingCall = new RegExp(`^\\s*(?:this\\.)?[\\w$.\\[\\]]+\\.(?:${PROMISE_METHODS})\\s*\\(`);
  maskedLines.forEach((mLine, i) => {
    if (!floatingCall.test(mLine)) return;
    if (/^\s*(await|return|yield|void)\b/.test(mLine) || /=\s*$/.test(maskedLines[i - 1] ?? '')) return;
    const offset = maskedLines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0);
    add(offset, 'floating-promise', 'high', 'Llamada asíncrona sin await/return: los errores no se capturan y la respuesta puede enviarse antes de que termine la operación.');
  });

  // 4. forEach con callback async: las promesas no se esperan.
  for (const match of masked.matchAll(/\.forEach\s*\(\s*async\b/g)) {
    add(match.index ?? 0, 'async-foreach', 'high', 'forEach(async …) no espera las promesas: usar for…of con await o Promise.all.');
  }

  // 5. new Promise(async …): las excepciones dentro del executor no rechazan la promesa.
  for (const match of masked.matchAll(/new\s+Promise\s*\(\s*async\b/g)) {
    add(match.index ?? 0, 'async-promise-executor', 'medium', 'new Promise(async …): una excepción en el executor no rechaza la promesa.');
  }

  // 6. Respuestas 2xx con payload de error.
  for (const match of src.matchAll(/res(?:ponse)?\s*\.\s*status\s*\(\s*2\d\d\s*\)\s*\.\s*(?:json|send)\s*\(\s*\{[^}]*\berror\b/g)) {
    add(match.index ?? 0, 'error-with-2xx', 'high', 'Respuesta HTTP 2xx con payload { error }: debe usarse un status 4xx/5xx (o lanzar HttpException).');
  }
  for (const match of src.matchAll(/res(?:ponse)?\s*\.\s*(?:json|send)\s*\(\s*\{[^}]*\berror\b/g)) {
    add(match.index ?? 0, 'error-with-2xx', 'high', 'res.json({ error }) sin status explícito responde 200 OK con un error dentro.');
  }
  maskedLines.forEach((mLine, i) => {
    if (/^\s*return\s*\{\s*(error|errors|success\s*:\s*false)\b/.test(src.split('\n')[i] ?? '') && /\breturn\b/.test(mLine)) {
      const offset = maskedLines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0);
      add(offset, 'error-as-payload', isController ? 'high' : 'medium', 'Se devuelve un objeto de error como valor normal: Nest lo serializa con status 200/201. Lanzar una HttpException adecuada.');
    }
  });

  // 7. throw new Error genérico en capa Nest: termina en HTTP 500 en vez de 4xx.
  if (/@(Injectable|Controller)\(/.test(masked)) {
    for (const match of masked.matchAll(/\bthrow\s+new\s+(Error|TypeError|RangeError)\s*\(/g)) {
      add(match.index ?? 0, 'generic-error-500', 'medium', `throw new ${match[1]}() en un provider/controlador de Nest produce HTTP 500. Usar NotFoundException, BadRequestException, ConflictException, etc.`);
    }
  }

  // 8. Status HTTP incoherente con el decorador.
  for (const match of masked.matchAll(/@HttpCode\(\s*(?:HttpStatus\.)?(\w+)\s*\)\s*(?:@\w+\([^)]*\)\s*)*@(Post|Get|Put|Patch|Delete)\(/g)) {
    const code = match[1] ?? '';
    const verb = match[2] ?? '';
    if (verb === 'Delete' && /^(201|CREATED)$/.test(code)) add(match.index ?? 0, 'wrong-status-code', 'low', 'DELETE con @HttpCode(201): debería ser 200 o 204.');
    if (verb === 'Get' && /^(201|CREATED|204|NO_CONTENT)$/.test(code)) add(match.index ?? 0, 'wrong-status-code', 'medium', `GET con @HttpCode(${code}): un GET que devuelve datos debe responder 200.`);
  }

  // 9. Rutas con parámetro declaradas antes que rutas literales del mismo verbo (Nest resuelve en orden).
  if (isController) {
    const routes = [...masked.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g)].map((m) => ({
      verb: m[1] ?? '',
      route: src.slice((m.index ?? 0), (m.index ?? 0) + m[0].length).match(/['"]([^'"]*)['"]/)?.[1] ?? '',
      index: m.index ?? 0,
    }));
    routes.forEach((r, i) => {
      if (!/^:[\w]+$/.test(r.route)) return;
      for (const later of routes.slice(i + 1)) {
        if (later.verb === r.verb && later.route !== '' && !later.route.includes(':') && !later.route.includes('/')) {
          add(r.index, 'route-shadowing', 'high', `@${r.verb}('${r.route}') está declarado antes que @${later.verb}('${later.route}'): la ruta literal nunca se alcanza ("${later.route}" se interpreta como :id).`);
        }
      }
    });
  }

  // 10. Métodos async que no usan await ni devuelven nada (posible await olvidado).
  for (const match of masked.matchAll(/\basync\s+(\w+)\s*\(/g)) {
    const paramsClose = findMatchingBrace(masked, (match.index ?? 0) + match[0].length - 1, '(', ')');
    if (paramsClose === -1) continue;
    // Saltar la anotación de retorno (p. ej. Promise<{ a: string }>): el cuerpo es la primera '{' fuera de genéricos.
    let open = -1;
    let angle = 0;
    for (let k = paramsClose + 1; k < masked.length; k++) {
      const ch = masked[k];
      if (ch === '<') angle++;
      else if (ch === '>' && masked[k - 1] !== '=') angle--;
      else if (ch === ';' && angle === 0) break;
      else if (ch === '{' && angle === 0) {
        open = k;
        break;
      }
    }
    if (open === -1) continue;
    const close = findMatchingBrace(masked, open);
    if (close === -1) continue;
    const body = masked.slice(open + 1, close);
    if (body.trim() !== '' && !/\bawait\b/.test(body) && !/\breturn\b/.test(body) && !/\bthrow\b/.test(body)) {
      add(match.index ?? 0, 'async-without-await', 'low', `El método async ${match[1]}() no usa await ni devuelve nada: revisar si falta un await.`);
    }
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Variables de entorno ----

function inspectEnv(): Record<string, unknown> {
  const exampleFile = ['.env.example', '.env.sample', '.env.template'].find((f) => existsSync(path.join(BACKEND_ROOT, f)));
  const exampleVars = exampleFile ? readBackendDotEnv(exampleFile) : new Map<string, string>();
  const dotEnv = readBackendDotEnv('.env');

  const references = new Map<string, Set<string>>();
  const addRef = (name: string, where: string): void => {
    if (!references.has(name)) references.set(name, new Set());
    references.get(name)?.add(where);
  };
  const srcDir = path.join(BACKEND_ROOT, 'src');
  const roots = [srcDir, path.join(BACKEND_ROOT, 'scripts')].filter((d) => existsSync(d));
  for (const file of roots.flatMap((d) => listSourceFiles(d))) {
    const src = readFileSync(file, 'utf8');
    const rel = toBackendRelative(file);
    for (const m of src.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g)) {
      const name = m[1] ?? m[2];
      if (name) addRef(name, `${rel}:${lineOf(src, m.index ?? 0)}`);
    }
    // ConfigService de NestJS: config.get('X') / getOrThrow<T>('X')
    for (const m of src.matchAll(/\.(?:get|getOrThrow)\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
      if (m[1]) addRef(m[1], `${rel}:${lineOf(src, m.index ?? 0)}`);
    }
  }

  // Variables obligatorias según la validación de entorno (class-validator / Joi / zod) si existe.
  const requiredByValidation = new Set<string>();
  for (const candidate of ['src/config/env.validation.ts', 'src/config/env.ts', 'src/config/configuration.ts', 'src/env.ts']) {
    const file = path.join(BACKEND_ROOT, candidate);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    const masked = maskCommentsAndStrings(src);
    for (const m of src.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*([!?])?\s*:/gm)) {
      const decoratorsAbove = src.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0);
      const optional = m[2] === '?' || /@IsOptional\(\)[^;]*$/.test(decoratorsAbove.split(/;\s*\n/).pop() ?? '') || /\.optional\(\)/.test(masked.slice(m.index ?? 0, (m.index ?? 0) + 200).split('\n')[0] ?? '');
      if (m[1] && !optional) requiredByValidation.add(m[1]);
      if (m[1]) addRef(m[1], `${candidate}:${lineOf(src, m.index ?? 0)}`);
    }
  }

  const status = (name: string): 'set' | 'empty' | 'missing' => {
    const runtime = process.env[name] ?? dotEnv.get(name);
    if (runtime === undefined) return 'missing';
    return runtime.trim() === '' ? 'empty' : 'set';
  };

  const allNames = new Set<string>([...exampleVars.keys(), ...references.keys()]);
  const NOISE = new Set(['NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'TZ', 'npm_package_version']);
  const variables = [...allNames]
    .filter((n) => !NOISE.has(n))
    .sort()
    .map((name) => ({
      name,
      inExample: exampleVars.has(name),
      exampleHasDefault: (exampleVars.get(name) ?? '').trim() !== '',
      runtimeStatus: status(name),
      requiredByValidation: requiredByValidation.has(name),
      referencedIn: [...(references.get(name) ?? [])].slice(0, 10),
    }));

  const issues: string[] = [];
  for (const v of variables) {
    if ((v.requiredByValidation || v.referencedIn.length > 0) && v.runtimeStatus !== 'set') {
      issues.push(`${v.name}: ${v.runtimeStatus === 'missing' ? 'no definida' : 'vacía'} en el entorno/.env pero el código la usa${v.requiredByValidation ? ' y la validación la exige (el arranque fallará)' : ''}.`);
    }
    if (v.referencedIn.length > 0 && !v.inExample) issues.push(`${v.name}: usada en el código pero no documentada en ${exampleFile ?? '.env.example'}.`);
    if (v.inExample && v.referencedIn.length === 0) issues.push(`${v.name}: declarada en ${exampleFile} pero ningún archivo de src/ la lee (variable muerta o nombre distinto en el código).`);
  }
  const dotEnvOnly = [...dotEnv.keys()].filter((k) => !exampleVars.has(k));
  if (dotEnvOnly.length > 0) issues.push(`Variables presentes en .env pero ausentes en ${exampleFile ?? '.env.example'}: ${dotEnvOnly.join(', ')}.`);

  return {
    exampleFile: exampleFile ?? null,
    dotEnvPresent: existsSync(path.join(BACKEND_ROOT, '.env')),
    note: 'Los valores nunca se muestran; solo se informa si están definidos, vacíos o ausentes (process.env del servidor MCP + .env del backend).',
    issues,
    variables,
  };
}

export function registerCodeAuditorTools(server: McpServer): void {
  server.registerTool(
    'read_backend_file',
    {
      title: 'Leer archivo del backend',
      description: 'Lee un archivo del backend (ruta relativa a la raíz del repo) con números de línea. Bloquea Path Traversal y enlaces simbólicos que salgan del repo.',
      inputSchema: {
        relative_path: z.string().min(1).max(1024).describe('Ruta relativa a la raíz del backend, ej. src/groups/groups.service.ts'),
        start_line: z.number().int().min(1).optional().describe('Primera línea a mostrar (1-indexada).'),
        end_line: z.number().int().min(1).optional().describe('Última línea a mostrar (inclusive).'),
      },
    },
    safeHandler('read_backend_file', async ({ relative_path, start_line, end_line }) => {
      const abs = resolveBackendPath(relative_path);
      if (!existsSync(abs)) return errorResult(`No existe el archivo: ${relative_path}`);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return jsonResult({ directory: toBackendRelative(abs) || '.', entries });
      }
      if (stat.size > MAX_FILE_BYTES) return errorResult(`Archivo demasiado grande (${stat.size} bytes, máximo ${MAX_FILE_BYTES}).`);
      const lines = readFileSync(abs, 'utf8').split('\n');
      const from = Math.min(start_line ?? 1, lines.length);
      const to = Math.min(end_line ?? lines.length, lines.length);
      if (to < from) return errorResult('end_line debe ser mayor o igual que start_line.');
      const width = String(to).length;
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(width, ' ')}\t${l}`)
        .join('\n');
      return { content: [{ type: 'text', text: `// ${toBackendRelative(abs)} (líneas ${from}-${to} de ${lines.length})\n${body}` }] };
    }),
  );

  server.registerTool(
    'audit_error_handling',
    {
      title: 'Auditar manejo de errores',
      description:
        'Analiza estáticamente un controlador/servicio (o todos los .ts de un directorio) buscando: promesas sin await, catch vacíos o que tragan errores, ' +
        '.then() sin .catch(), forEach(async), throw new Error genérico (HTTP 500 en Nest), respuestas 2xx con payload { error }, ' +
        'status codes incoherentes y rutas ":id" que ocultan rutas literales.',
      inputSchema: {
        relative_path: z.string().min(1).max(1024).describe('Archivo o directorio relativo al backend, ej. src/groups o src/groups/groups.service.ts'),
      },
    },
    safeHandler('audit_error_handling', async ({ relative_path }) => {
      const abs = resolveBackendPath(relative_path);
      if (!existsSync(abs)) return errorResult(`No existe: ${relative_path}`);
      const files = statSync(abs).isDirectory() ? listSourceFiles(abs, /\.(ts|js)$/).filter((f) => !/\.(spec|test)\.ts$/.test(f)) : [abs];
      const findings: AuditFinding[] = [];
      for (const file of files) {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        findings.push(...auditSource(toBackendRelative(file), readFileSync(file, 'utf8')));
      }
      const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
      const bySeverity = findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
      return jsonResult({
        scannedFiles: files.length,
        totalFindings: findings.length,
        bySeverity,
        note: 'Análisis heurístico: confirmar cada hallazgo leyendo el código con read_backend_file antes de parchear.',
        findings,
      });
    }),
  );

  server.registerTool(
    'inspect_env_variables',
    {
      title: 'Inspeccionar variables de entorno',
      description:
        'Contrasta .env.example, el .env del backend, process.env y las referencias en el código (process.env.X y ConfigService.get/getOrThrow) ' +
        'para detectar variables críticas ausentes, vacías, no documentadas o muertas. Nunca revela valores.',
      inputSchema: {},
    },
    safeHandler('inspect_env_variables', async () => jsonResult(inspectEnv())),
  );
}
