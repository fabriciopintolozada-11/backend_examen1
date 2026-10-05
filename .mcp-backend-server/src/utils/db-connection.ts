import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { BACKEND_ROOT } from './paths.js';

/** Parsea el .env del backend sin mutar process.env (los valores nunca se devuelven al cliente). */
export function readBackendDotEnv(fileName = '.env'): Map<string, string> {
  const vars = new Map<string, string>();
  const file = path.join(BACKEND_ROOT, fileName);
  if (!existsSync(file)) return vars;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    vars.set(match[1], value);
  }
  return vars;
}

/** Busca una variable primero en el entorno del servidor y luego en el .env del backend. */
export function getEnvVar(name: string): { value: string | undefined; source: 'process.env' | '.env' | 'none' } {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return { value: fromProcess, source: 'process.env' };
  const fromFile = readBackendDotEnv().get(name);
  if (fromFile !== undefined && fromFile !== '') return { value: fromFile, source: '.env' };
  return { value: undefined, source: 'none' };
}

/** Oculta credenciales de una cadena de conexión para poder mostrarla en reportes. */
export function redactConnectionString(uri: string): string {
  return uri.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:****@');
}

// ---------------- PostgreSQL (pg) ----------------

let pgPool: pg.Pool | null = null;

export function isPostgresUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^postgres(ql)?:\/\//i.test(url);
}

export function getPostgresPool(): pg.Pool {
  const { value } = getEnvVar('DATABASE_URL');
  if (!isPostgresUrl(value)) {
    throw new Error('DATABASE_URL no está configurada o no es una URL postgres:// válida.');
  }
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: value,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
    pgPool.on('error', (error) => console.error('[backend-qa] Error en pool de Postgres:', error));
  }
  return pgPool;
}

export async function withPgClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ---------------- MongoDB (driver del propio backend) ----------------

/** Subconjunto tipado del driver `mongodb` que usamos (se carga desde node_modules del backend). */
export interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
}
interface MongoCollectionLike {
  estimatedDocumentCount(): Promise<number>;
  indexes(): Promise<MongoIndexInfo[]>;
  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<Record<string, unknown>[]> };
}
interface MongoDbLike {
  databaseName: string;
  listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): { toArray(): Promise<Array<{ name: string; type?: string }>> };
  collection(name: string): MongoCollectionLike;
}
export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoDbLike;
  close(): Promise<void>;
}
type MongoClientCtor = new (uri: string, options?: Record<string, unknown>) => MongoClientLike;

export function getMongoUri(): { uri: string | undefined; source: string } {
  for (const name of ['MONGODB_URI', 'MONGO_URI', 'DATABASE_URL']) {
    const { value, source } = getEnvVar(name);
    if (value && /^mongodb(\+srv)?:\/\//i.test(value)) return { uri: value, source: `${name} (${source})` };
  }
  return { uri: undefined, source: 'none' };
}

/** Carga el driver `mongodb` instalado en el backend (dependencia transitiva de mongoose). */
function loadBackendMongoDriver(): MongoClientCtor {
  const backendRequire = createRequire(path.join(BACKEND_ROOT, 'package.json'));
  const mod = backendRequire('mongodb') as { MongoClient?: MongoClientCtor };
  if (!mod.MongoClient) throw new Error('El paquete mongodb del backend no expone MongoClient.');
  return mod.MongoClient;
}

export async function withMongoDb<T>(uri: string, fn: (db: MongoDbLike) => Promise<T>): Promise<T> {
  const MongoClient = loadBackendMongoDriver();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 });
  try {
    await client.connect();
    return await fn(client.db());
  } finally {
    await client.close().catch((error: unknown) => console.error('[backend-qa] Error cerrando MongoClient:', error));
  }
}

/** Pluralización de nombres de colección usando la misma función que mongoose (con fallback simple). */
export function mongoosePluralize(modelName: string): string {
  try {
    const backendRequire = createRequire(path.join(BACKEND_ROOT, 'package.json'));
    const mongoose = backendRequire('mongoose') as { pluralize?: () => ((s: string) => string) | null };
    const fn = mongoose.pluralize?.();
    if (typeof fn === 'function') return fn(modelName);
  } catch (error) {
    console.error('[backend-qa] No se pudo cargar mongoose para pluralizar, usando fallback:', error);
  }
  const lower = modelName.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

export async function closeAllConnections(): Promise<void> {
  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    await pool.end().catch((error: unknown) => console.error('[backend-qa] Error cerrando pool de Postgres:', error));
  }
}
