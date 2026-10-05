import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, safeHandler, truncate } from '../utils/process.js';

const MAX_BODY_CHARS = 100_000;

interface HttpProbeResult {
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  status: number;
  statusText: string;
  ok: boolean;
  durationMs: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: unknown;
  bodyIsJson: boolean;
  expectedStatus?: number;
  statusMatchesExpectation?: boolean;
  diagnosis: string[];
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|x-api-key)$/i.test(key) ? `${value.slice(0, 12)}…(redactado)` : value;
  }
  return out;
}

function diagnose(status: number, body: unknown, expected: number | undefined): string[] {
  const notes: string[] = [];
  if (expected !== undefined && status !== expected) notes.push(`Se esperaba HTTP ${expected} y se recibió HTTP ${status}.`);
  if (status >= 500) {
    notes.push('Error no controlado del servidor (5xx): revisar el stack en la consola del backend y el filtro global de excepciones.');
  }
  if (status === 404) notes.push('404: verificar el prefijo global (app.setGlobalPrefix), el path de @Controller() y el orden de rutas (":id" antes de rutas literales).');
  if (status === 401) notes.push('401: el endpoint requiere JWT (Authorization: Bearer <token>) o el token expiró/es inválido.');
  if (status === 403) notes.push('403: el rol del usuario no está autorizado por @Roles() o el guard de roles.');
  if (status === 400 && body && typeof body === 'object' && 'message' in body) notes.push('400: la ValidationPipe rechazó el payload; revisar el campo "message" para ver las restricciones del DTO.');
  if (status >= 200 && status < 300 && body && typeof body === 'object' && !Array.isArray(body) && ('error' in body || 'errors' in body)) {
    notes.push('Anti-patrón: respuesta 2xx con payload de error. El servidor debería devolver un status 4xx/5xx.');
  }
  return notes;
}

async function probe(params: {
  endpoint_url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  expected_status?: number;
  timeout_ms: number;
}): Promise<HttpProbeResult> {
  const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', ...(params.headers ?? {}) };
  let body: string | undefined;
  if (params.body !== undefined && params.body !== null) {
    if (params.method === 'GET') throw new Error('Una petición GET no puede llevar body.');
    body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasContentType) {
      const looksJson = typeof params.body !== 'string' || /^\s*[[{]/.test(params.body);
      headers['content-type'] = looksJson ? 'application/json' : 'text/plain';
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeout_ms);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(params.endpoint_url, { method: params.method, headers, body, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
  const rawText = await response.text();
  const durationMs = Math.round(performance.now() - started);

  const contentType = response.headers.get('content-type');
  let parsed: unknown = truncate(rawText, MAX_BODY_CHARS);
  let bodyIsJson = false;
  if (rawText.trim() !== '' && (contentType?.includes('json') || /^\s*[[{]/.test(rawText))) {
    try {
      parsed = JSON.parse(rawText);
      bodyIsJson = true;
    } catch {
      bodyIsJson = false;
    }
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    request: { method: params.method, url: params.endpoint_url, headers: redactHeaders(headers), ...(body !== undefined ? { body: truncate(body, 5_000) } : {}) },
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    durationMs,
    headers: responseHeaders,
    contentType,
    body: parsed,
    bodyIsJson,
    ...(params.expected_status !== undefined ? { expectedStatus: params.expected_status, statusMatchesExpectation: response.status === params.expected_status } : {}),
    diagnosis: diagnose(response.status, parsed, params.expected_status),
  };
}

export function registerApiTesterTools(server: McpServer): void {
  server.registerTool(
    'http_request_endpoint',
    {
      title: 'Probar endpoint HTTP',
      description:
        'Envía una petición HTTP real (fetch nativo) a un endpoint del backend en ejecución. Mide el tiempo de respuesta y devuelve status, ' +
        'cabeceras y payload parseado. Ante 5xx o errores no controlados captura el cuerpo del error y añade un diagnóstico. ' +
        'Nota: este backend usa el prefijo global definido en src/main.ts (p. ej. http://localhost:3000/api/...).',
      inputSchema: {
        endpoint_url: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//i.test(u), 'Solo se permiten URLs http:// o https://')
          .describe('URL completa, ej. http://localhost:3000/api/groups'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        headers: z.record(z.string()).optional().describe('Cabeceras adicionales, ej. { "Authorization": "Bearer <jwt>" }'),
        body: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional().describe('Body como string o como objeto/array JSON.'),
        expected_status: z.number().int().min(100).max(599).optional().describe('Status HTTP esperado para validar la respuesta.'),
        timeout_ms: z.number().int().min(100).max(120_000).optional().default(30_000),
      },
    },
    safeHandler('http_request_endpoint', async (args) => {
      try {
        const result = await probe({ ...args, timeout_ms: args.timeout_ms ?? 30_000 });
        const failedExpectation = result.statusMatchesExpectation === false;
        return failedExpectation || result.status >= 500 ? { ...jsonResult(result), isError: true } : jsonResult(result);
      } catch (error) {
        const err = error as Error & { cause?: { code?: string; message?: string } };
        if (err.name === 'AbortError') return errorResult(`Timeout: el endpoint no respondió en ${args.timeout_ms} ms.`);
        const code = err.cause?.code;
        const hint = code === 'ECONNREFUSED' ? ' ¿Está levantado el backend? (npm run start:dev) y ¿el puerto coincide con PORT del .env?' : '';
        return errorResult(`No se pudo conectar con ${args.endpoint_url}: ${code ?? err.message}${hint}`, { cause: err.cause?.message ?? err.message });
      }
    }),
  );
}
