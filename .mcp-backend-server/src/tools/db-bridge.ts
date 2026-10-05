import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEnvVar, getMongoUri, isPostgresUrl, mongoosePluralize, redactConnectionString, withMongoDb, withPgClient, type MongoIndexInfo } from '../utils/db-connection.js';
import { BACKEND_ROOT, toBackendRelative } from '../utils/paths.js';
import { errorResult, jsonResult, safeHandler, truncate } from '../utils/process.js';
import { findMatchingBrace, listSourceFiles, maskCommentsAndStrings } from './code-auditor.js';
import { readBackendPackageJson } from './test-runner.js';

// ---------------- Modelo común ----------------

interface ModelField {
  name: string;
  type: string;
  /** Tipo esperado en la base de datos (BSON para Mongo, aproximado para SQL). */
  dbType?: string;
  required: boolean;
  unique: boolean;
  indexed: boolean;
  isArray: boolean;
  ref?: string;
  hasDefault: boolean;
  enumRef?: string;
  line: number;
}

interface ModelIndex {
  fields: string[];
  unique: boolean;
  line: number;
}

interface CodeModel {
  orm: 'mongoose' | 'prisma' | 'typeorm';
  name: string;
  /** Colección/tabla física (null si es un subdocumento embebido). */
  storageName: string | null;
  embedded: boolean;
  registered: boolean;
  file: string;
  line: number;
  timestamps: boolean;
  fields: ModelField[];
  indexes: ModelIndex[];
}

interface Discrepancy {
  severity: 'high' | 'medium' | 'low' | 'info';
  model?: string;
  storage?: string;
  field?: string;
  kind: string;
  message: string;
  location?: string;
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Extrae el contenido entre paréntesis balanceados a partir de openIdx (que apunta a "("). */
function balancedArgs(src: string, masked: string, openIdx: number): { text: string; end: number } | null {
  const close = findMatchingBrace(masked, openIdx, '(', ')');
  if (close === -1) return null;
  return { text: src.slice(openIdx + 1, close), end: close };
}

function detectOrms(): string[] {
  const pkg = readBackendPackageJson();
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const known: Record<string, string> = {
    '@prisma/client': 'prisma',
    prisma: 'prisma',
    typeorm: 'typeorm',
    'drizzle-orm': 'drizzle',
    sequelize: 'sequelize',
    mongoose: 'mongoose',
    pg: 'pg (raw SQL)',
    mongodb: 'mongodb (driver)',
  };
  return [...new Set(Object.keys(deps).filter((d) => d in known).map((d) => known[d] as string))];
}

// ---------------- Mongoose (@nestjs/mongoose) ----------------

function tsTypeToBson(tsType: string, explicitType: string | undefined): { type: string; isArray: boolean } {
  const raw = (explicitType ?? tsType).trim();
  const isArray = /^\[.*\]$/.test(raw) || /\[\]$/.test(tsType.trim()) || /^Array</.test(tsType.trim());
  const base = raw.replace(/^\[|\]$/g, '').replace(/\[\]$/, '').trim();
  if (isArray) return { type: 'array', isArray: true };
  if (/ObjectId/.test(base)) return { type: 'objectId', isArray: false };
  if (/^(string|String)$/.test(base) || /^'.*'(\s*\|\s*'.*')*$/.test(base)) return { type: 'string', isArray: false };
  if (/^(number|Number)$/.test(base)) return { type: 'number', isArray: false };
  if (/^(boolean|Boolean)$/.test(base)) return { type: 'bool', isArray: false };
  if (/^Date$/.test(base)) return { type: 'date', isArray: false };
  if (/Mixed|Record<|object|any|unknown/.test(base)) return { type: 'any', isArray: false };
  if (/^[A-Z]\w*$/.test(base)) return { type: 'enum-or-subdocument', isArray: false };
  return { type: 'any', isArray: false };
}

function parseMongooseModels(): CodeModel[] {
  const srcDir = path.join(BACKEND_ROOT, 'src');
  if (!existsSync(srcDir)) return [];
  const files = listSourceFiles(srcDir, /\.ts$/);

  // Modelos registrados con MongooseModule.forFeature([{ name: X.name, ... }])
  const registered = new Set<string>();
  const sources = new Map<string, string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    sources.set(file, src);
    for (const ff of src.matchAll(/forFeature(?:Async)?\s*\(/g)) {
      const masked = maskCommentsAndStrings(src);
      const args = balancedArgs(src, masked, (ff.index ?? 0) + ff[0].length - 1);
      if (!args) continue;
      for (const n of args.text.matchAll(/name\s*:\s*(?:(\w+)\.name|['"](\w+)['"])/g)) registered.add((n[1] ?? n[2]) as string);
    }
  }

  const models: CodeModel[] = [];
  for (const file of files) {
    const src = sources.get(file) ?? '';
    if (!src.includes('@Schema(')) continue;
    const masked = maskCommentsAndStrings(src);
    const rel = toBackendRelative(file);

    for (const sm of masked.matchAll(/@Schema\s*\(/g)) {
      const optsArgs = balancedArgs(src, masked, (sm.index ?? 0) + sm[0].length - 1);
      if (!optsArgs) continue;
      const classMatch = /^\s*export\s+(?:abstract\s+)?class\s+(\w+)[^{]*\{/.exec(masked.slice(optsArgs.end + 1));
      if (!classMatch?.[1]) continue;
      const className = classMatch[1];
      const open = optsArgs.end + 1 + classMatch[0].length - 1;
      const close = findMatchingBrace(masked, open);
      if (close === -1) continue;
      const opts = optsArgs.text;
      const embedded = /_id\s*:\s*false/.test(opts) || !registered.has(className);
      const collection = /collection\s*:\s*['"]([^'"]+)['"]/.exec(opts)?.[1];

      const fields: ModelField[] = [];
      const classMasked = masked.slice(open, close);
      for (const pm of classMasked.matchAll(/@Prop\s*\(/g)) {
        const absIdx = open + (pm.index ?? 0);
        const propArgs = balancedArgs(src, masked, absIdx + pm[0].length - 1);
        if (!propArgs) continue;
        const after = src.slice(propArgs.end + 1, close);
        const decl = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:readonly\s+)?(\w+)\s*([!?])?\s*:\s*([^;=\n]+)/.exec(after);
        if (!decl?.[1]) continue;
        const a = propArgs.text;
        const explicitType = /\btype\s*:\s*(\[[^\]]*\]|[\w.]+)/.exec(a)?.[1];
        const tsType = (decl[3] ?? '').trim();
        const { type, isArray } = tsTypeToBson(tsType, explicitType);
        const enumRef = /\benum\s*:\s*([\w.]+)/.exec(a)?.[1];
        fields.push({
          name: decl[1],
          type: tsType,
          dbType: enumRef && type === 'enum-or-subdocument' ? 'string' : type,
          required: /\brequired\s*:\s*(true|\[\s*true)/.test(a),
          unique: /\bunique\s*:\s*true/.test(a),
          indexed: /\bindex\s*:\s*true/.test(a) || /\bunique\s*:\s*true/.test(a),
          isArray,
          ref: /\bref\s*:\s*(?:(\w+)\.name|['"](\w+)['"])/.exec(a)?.slice(1).find(Boolean),
          hasDefault: /\bdefault\s*:/.test(a),
          enumRef,
          line: lineAt(src, absIdx),
        });
      }

      // Índices compuestos: XSchema.index({ a: 1, b: 1 }, { unique: true })
      const indexes: ModelIndex[] = [];
      const schemaConst = new RegExp(`(\\w+)\\s*=\\s*SchemaFactory\\.createForClass\\(\\s*${className}\\s*\\)`).exec(src)?.[1] ?? `${className}Schema`;
      for (const im of masked.matchAll(new RegExp(`\\b${schemaConst}\\.index\\s*\\(`, 'g'))) {
        const idxArgs = balancedArgs(src, masked, (im.index ?? 0) + im[0].length - 1);
        if (!idxArgs) continue;
        const keysBlock = /^\s*\{([^}]*)\}/.exec(idxArgs.text)?.[1] ?? '';
        const keys = [...keysBlock.matchAll(/['"]?([\w.]+)['"]?\s*:/g)].map((k) => k[1] as string);
        indexes.push({ fields: keys, unique: /unique\s*:\s*true/.test(idxArgs.text.slice(keysBlock.length + 2)), line: lineAt(src, im.index ?? 0) });
      }
      for (const f of fields) if (f.indexed) indexes.push({ fields: [f.name], unique: f.unique, line: f.line });

      models.push({
        orm: 'mongoose',
        name: className,
        storageName: embedded ? null : (collection ?? mongoosePluralize(className)),
        embedded,
        registered: registered.has(className),
        file: rel,
        line: lineAt(src, sm.index ?? 0),
        timestamps: /timestamps\s*:\s*(true|\{)/.test(opts),
        fields,
        indexes,
      });
    }
  }
  return models;
}

// ---------------- Prisma ----------------

function parsePrismaModels(): CodeModel[] {
  const candidates = ['prisma/schema.prisma', 'schema.prisma'];
  const file = candidates.map((c) => path.join(BACKEND_ROOT, c)).find((f) => existsSync(f));
  if (!file) return [];
  const src = readFileSync(file, 'utf8');
  const models: CodeModel[] = [];
  for (const mm of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = mm[1] as string;
    const body = mm[2] ?? '';
    const baseLine = lineAt(src, mm.index ?? 0);
    const fields: ModelField[] = [];
    const indexes: ModelIndex[] = [];
    body.split('\n').forEach((rawLine, i) => {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (line === '') return;
      if (line.startsWith('@@')) {
        const idx = /^@@(unique|index|id)\s*\(\s*(?:fields\s*:\s*)?\[([^\]]+)\]/.exec(line);
        if (idx) indexes.push({ fields: (idx[2] ?? '').split(',').map((s) => s.trim()), unique: idx[1] !== 'index', line: baseLine + i + 1 });
        return;
      }
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!fm?.[1] || !fm[2]) return;
      const attrs = fm[5] ?? '';
      const isRelation = /@relation/.test(attrs) || (/^[A-Z]/.test(fm[2]) && !/^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)$/.test(fm[2]));
      const column = /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? fm[1];
      fields.push({
        name: isRelation && !/@relation\(.*fields/.test(attrs) ? `${fm[1]} (relación virtual)` : column,
        type: `${fm[2]}${fm[3] ?? ''}${fm[4] ?? ''}`,
        dbType: isRelation ? 'relation' : fm[2],
        required: !fm[4] && !fm[3],
        unique: /@unique|@id/.test(attrs),
        indexed: /@unique|@id/.test(attrs),
        isArray: Boolean(fm[3]),
        ref: isRelation ? fm[2] : undefined,
        hasDefault: /@default|@updatedAt/.test(attrs),
        line: baseLine + i + 1,
      });
    });
    models.push({
      orm: 'prisma',
      name,
      storageName: /@@map\(\s*"([^"]+)"/.exec(body)?.[1] ?? name,
      embedded: false,
      registered: true,
      file: toBackendRelative(file),
      line: baseLine,
      timestamps: false,
      fields,
      indexes,
    });
  }
  return models;
}

// ---------------- TypeORM ----------------

function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

function parseTypeOrmModels(): CodeModel[] {
  const srcDir = path.join(BACKEND_ROOT, 'src');
  if (!existsSync(srcDir)) return [];
  const models: CodeModel[] = [];
  for (const file of listSourceFiles(srcDir, /\.ts$/)) {
    const src = readFileSync(file, 'utf8');
    if (!/@Entity\s*\(/.test(src)) continue;
    const masked = maskCommentsAndStrings(src);
    for (const em of masked.matchAll(/@Entity\s*\(/g)) {
      const args = balancedArgs(src, masked, (em.index ?? 0) + em[0].length - 1);
      if (!args) continue;
      const cls = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*export\s+class\s+(\w+)[^{]*\{/.exec(masked.slice(args.end + 1));
      if (!cls?.[1]) continue;
      const open = args.end + 1 + cls[0].length - 1;
      const close = findMatchingBrace(masked, open);
      const body = src.slice(open, close);
      const fields: ModelField[] = [];
      for (const cm of body.matchAll(/@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|ManyToOne|OneToOne|OneToMany|ManyToMany|JoinColumn)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*(?:@\w+\([^)]*\)\s*)*(\w+)\s*[!?]?\s*:\s*([^;=\n]+)/g)) {
        const kind = cm[1] ?? '';
        const opts = cm[2] ?? '';
        const isRel = /ManyToOne|OneToOne|OneToMany|ManyToMany/.test(kind);
        fields.push({
          name: isRel && /OneToMany|ManyToMany/.test(kind) ? `${cm[3]} (relación virtual)` : isRel ? `${snakeCase(cm[3] ?? '')}_id` : (/name\s*:\s*['"]([^'"]+)/.exec(opts)?.[1] ?? cm[3] ?? ''),
          type: (cm[4] ?? '').trim(),
          dbType: isRel ? 'relation' : (/type\s*:\s*['"]([^'"]+)/.exec(opts)?.[1] ?? /^\s*['"]([^'"]+)/.exec(opts)?.[1]),
          required: !/nullable\s*:\s*true/.test(opts) && !/Primary/.test(kind),
          unique: /unique\s*:\s*true/.test(opts) || /Primary/.test(kind),
          indexed: /Primary/.test(kind),
          isArray: /\[\]/.test(cm[4] ?? ''),
          ref: isRel ? /=>\s*(\w+)/.exec(opts)?.[1] : undefined,
          hasDefault: /default\s*:/.test(opts) || /Generated|DateColumn/.test(kind),
          line: lineAt(src, open + (cm.index ?? 0)),
        });
      }
      const explicit = /^\s*['"]([^'"]+)['"]/.exec(args.text)?.[1] ?? /name\s*:\s*['"]([^'"]+)['"]/.exec(args.text)?.[1];
      models.push({
        orm: 'typeorm',
        name: cls[1],
        storageName: explicit ?? snakeCase(cls[1]),
        embedded: false,
        registered: true,
        file: toBackendRelative(file),
        line: lineAt(src, em.index ?? 0),
        timestamps: false,
        fields,
        indexes: [],
      });
    }
  }
  return models;
}

// ---------------- Inspección en vivo: MongoDB ----------------

const BSON_NUMERIC = new Set(['double', 'int', 'long', 'decimal']);

function bsonCompatible(expected: string | undefined, observed: string): boolean {
  if (!expected || expected === 'any' || observed === 'null' || observed === 'missing') return true;
  if (expected === 'number') return BSON_NUMERIC.has(observed);
  if (expected === 'enum-or-subdocument') return observed === 'object' || observed === 'string' || BSON_NUMERIC.has(observed);
  return expected === observed;
}

function indexMatches(declared: ModelIndex, actual: MongoIndexInfo): boolean {
  const keys = Object.keys(actual.key);
  return keys.length === declared.fields.length && declared.fields.every((f, i) => keys[i] === f);
}

async function inspectMongoLive(models: CodeModel[], sampleSize: number): Promise<{ live: Record<string, unknown>; discrepancies: Discrepancy[] }> {
  const { uri, source } = getMongoUri();
  if (!uri) return { live: { connected: false, reason: 'No hay MONGODB_URI / MONGO_URI en el entorno ni en el .env del backend.' }, discrepancies: [] };
  const discrepancies: Discrepancy[] = [];
  try {
    const live = await withMongoDb(uri, async (db) => {
      const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).filter((c) => c.type !== 'view' && !c.name.startsWith('system.'));
      const names = new Set(collections.map((c) => c.name));
      const physical = models.filter((m) => !m.embedded && m.storageName);
      const expected = new Set(physical.map((m) => m.storageName as string));
      const perCollection: Record<string, unknown> = {};

      if (collections.length === 0) {
        discrepancies.push({ severity: 'info', kind: 'empty-database', message: `La base "${db.databaseName}" no tiene colecciones: probablemente no se ha ejecutado el seed (npm run db:seed) ni arrancado la API.` });
      }

      for (const model of physical) {
        const coll = model.storageName as string;
        if (!names.has(coll)) {
          if (collections.length > 0) {
            discrepancies.push({ severity: 'medium', model: model.name, storage: coll, kind: 'missing-collection', message: `El modelo ${model.name} espera la colección "${coll}" pero no existe en la base.`, location: `${model.file}:${model.line}` });
          }
          continue;
        }
        const collection = db.collection(coll);
        const [count, indexes, typeRows] = await Promise.all([
          collection.estimatedDocumentCount(),
          collection.indexes(),
          collection
            .aggregate([
              { $sample: { size: sampleSize } },
              { $project: { kv: { $objectToArray: '$$ROOT' } } },
              { $unwind: '$kv' },
              { $group: { _id: { k: '$kv.k', t: { $type: '$kv.v' } }, n: { $sum: 1 } } },
            ])
            .toArray(),
        ]);
        const sampled = Math.min(count, sampleSize);
        const observed = new Map<string, Map<string, number>>();
        for (const row of typeRows) {
          const id = row._id as { k: string; t: string };
          if (!observed.has(id.k)) observed.set(id.k, new Map());
          observed.get(id.k)?.set(id.t, row.n as number);
        }

        const declaredNames = new Set(model.fields.map((f) => f.name));
        const systemFields = new Set(['_id', '__v', ...(model.timestamps ? ['createdAt', 'updatedAt'] : [])]);

        for (const field of model.fields) {
          const types = observed.get(field.name);
          const present = types ? [...types.values()].reduce((a, b) => a + b, 0) : 0;
          if (field.required && !field.hasDefault && sampled > 0 && present < sampled) {
            discrepancies.push({ severity: 'high', model: model.name, storage: coll, field: field.name, kind: 'required-field-missing', message: `Campo requerido "${field.name}" ausente en ${sampled - present}/${sampled} documentos muestreados (datos inválidos o seed desactualizado).`, location: `${model.file}:${field.line}` });
          }
          for (const [bsonType, n] of types ?? []) {
            if (!bsonCompatible(field.dbType, bsonType)) {
              discrepancies.push({ severity: 'high', model: model.name, storage: coll, field: field.name, kind: 'type-mismatch', message: `El schema declara ${field.type} (${field.dbType}) pero ${n} documento(s) guardan tipo BSON "${bsonType}". Los filtros y populate fallarán silenciosamente.`, location: `${model.file}:${field.line}` });
            }
          }
        }
        for (const [fieldName, types] of observed) {
          if (!declaredNames.has(fieldName) && !systemFields.has(fieldName)) {
            const n = [...types.values()].reduce((a, b) => a + b, 0);
            discrepancies.push({ severity: 'medium', model: model.name, storage: coll, field: fieldName, kind: 'undeclared-field', message: `${n} documento(s) contienen "${fieldName}", que no existe en el schema (deriva de esquema; mongoose lo ignora en modo strict).`, location: `${model.file}:${model.line}` });
          }
        }

        for (const declared of model.indexes) {
          const match = indexes.find((ix) => indexMatches(declared, ix));
          if (!match) {
            discrepancies.push({ severity: declared.unique ? 'high' : 'low', model: model.name, storage: coll, field: declared.fields.join(','), kind: declared.unique ? 'missing-unique-index' : 'missing-index', message: `Índice ${declared.unique ? 'ÚNICO ' : ''}{${declared.fields.join(', ')}} declarado en código pero inexistente en la base${declared.unique ? ': la unicidad NO se está garantizando (posibles duplicados o autoIndex falló por datos duplicados)' : ''}.`, location: `${model.file}:${declared.line}` });
          } else if (declared.unique && !match.unique) {
            discrepancies.push({ severity: 'high', model: model.name, storage: coll, field: declared.fields.join(','), kind: 'index-not-unique', message: `El índice ${match.name} existe pero no es único en la base, aunque el código lo declara unique.`, location: `${model.file}:${declared.line}` });
          }
        }
        for (const ix of indexes) {
          if (ix.name === '_id_') continue;
          if (!model.indexes.some((d) => indexMatches(d, ix))) {
            discrepancies.push({ severity: ix.unique ? 'medium' : 'low', model: model.name, storage: coll, field: Object.keys(ix.key).join(','), kind: ix.unique ? 'stale-unique-index' : 'stale-index', message: `Índice "${ix.name}"${ix.unique ? ' ÚNICO' : ''} existe en la base pero no en el código${ix.unique ? ': puede provocar errores E11000 inesperados al insertar' : ''}.` });
          }
        }

        perCollection[coll] = {
          model: model.name,
          documents: count,
          sampled,
          indexes: indexes.map((ix) => ({ name: ix.name, key: ix.key, unique: Boolean(ix.unique) })),
          observedFields: Object.fromEntries([...observed].map(([k, t]) => [k, Object.fromEntries(t)])),
        };
      }

      for (const name of names) {
        if (!expected.has(name)) discrepancies.push({ severity: 'low', storage: name, kind: 'orphan-collection', message: `La colección "${name}" existe en la base pero ningún modelo registrado la usa.` });
      }
      return { connected: true, uri: redactConnectionString(uri), uriSource: source, database: db.databaseName, collections: collections.map((c) => c.name).sort(), perCollection };
    });
    return { live, discrepancies };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      live: {
        connected: false,
        uri: redactConnectionString(uri),
        uriSource: source,
        error: message,
        hint: /ECONNREFUSED|Server selection timed out|getaddrinfo/i.test(message)
          ? '¿Está levantado Mongo (npm run db:up)? Compara el puerto de MONGODB_URI con el puerto publicado en docker-compose.yml.'
          : undefined,
      },
      discrepancies: [{ severity: 'high', kind: 'db-connection-failed', message: `No se pudo conectar a MongoDB (${redactConnectionString(uri)}): ${message}` }],
    };
  }
}

// ---------------- Inspección en vivo: PostgreSQL ----------------

async function inspectPostgresLive(models: CodeModel[]): Promise<{ live: Record<string, unknown>; discrepancies: Discrepancy[] }> {
  const { value } = getEnvVar('DATABASE_URL');
  if (!isPostgresUrl(value)) return { live: { connected: false, reason: 'DATABASE_URL no está configurada o no apunta a Postgres.' }, discrepancies: [] };
  const discrepancies: Discrepancy[] = [];
  try {
    const live = await withPgClient(async (client) => {
      const tables = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema::text, table_name::text FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
      );
      const columns = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT table_name::text, column_name::text, data_type::text, is_nullable::text, column_default::text
         FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name, ordinal_position`,
      );
      const constraints = await client.query<{ table_name: string; constraint_type: string; constraint_name: string; column_name: string }>(
        `SELECT tc.table_name::text, tc.constraint_type::text, tc.constraint_name::text, kcu.column_name::text
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );

      const colsByTable = new Map<string, typeof columns.rows>();
      for (const c of columns.rows) {
        if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, []);
        colsByTable.get(c.table_name)?.push(c);
      }
      const sqlModels = models.filter((m) => m.orm !== 'mongoose' && m.storageName);
      const tableNames = new Set(tables.rows.map((t) => t.table_name));
      for (const model of sqlModels) {
        const table = model.storageName as string;
        if (!tableNames.has(table)) {
          discrepancies.push({ severity: 'high', model: model.name, storage: table, kind: 'missing-table', message: `El modelo ${model.name} espera la tabla "${table}" pero no existe (¿migración pendiente?).`, location: `${model.file}:${model.line}` });
          continue;
        }
        const dbCols = colsByTable.get(table) ?? [];
        const dbColNames = new Set(dbCols.map((c) => c.column_name));
        for (const f of model.fields) {
          if (f.name.includes('(relación virtual)')) continue;
          if (!dbColNames.has(f.name)) {
            discrepancies.push({ severity: 'high', model: model.name, storage: table, field: f.name, kind: 'missing-column', message: `Columna "${f.name}" declarada en el modelo no existe en la tabla.`, location: `${model.file}:${f.line}` });
            continue;
          }
          const col = dbCols.find((c) => c.column_name === f.name);
          if (col && f.required && col.is_nullable === 'YES') {
            discrepancies.push({ severity: 'medium', model: model.name, storage: table, field: f.name, kind: 'nullability-mismatch', message: `El modelo marca "${f.name}" como obligatorio pero la columna admite NULL.`, location: `${model.file}:${f.line}` });
          }
          if (col && !f.required && col.is_nullable === 'NO' && col.column_default === null) {
            discrepancies.push({ severity: 'high', model: model.name, storage: table, field: f.name, kind: 'nullability-mismatch', message: `El modelo permite "${f.name}" opcional pero la columna es NOT NULL sin default: los INSERT fallarán.`, location: `${model.file}:${f.line}` });
          }
        }
        const modelCols = new Set(model.fields.map((f) => f.name));
        for (const c of dbCols) {
          if (!modelCols.has(c.column_name)) discrepancies.push({ severity: 'low', model: model.name, storage: table, field: c.column_name, kind: 'unmapped-column', message: `Columna "${c.column_name}" existe en la tabla pero no está mapeada en el modelo.` });
        }
      }
      return {
        connected: true,
        uri: redactConnectionString(value),
        tables: tables.rows.map((t) => `${t.table_schema}.${t.table_name}`),
        columns: Object.fromEntries([...colsByTable].map(([t, cols]) => [t, cols.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default }))])),
        constraints: constraints.rows,
      };
    });
    return { live, discrepancies };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { live: { connected: false, uri: redactConnectionString(value), error: message }, discrepancies: [{ severity: 'high', kind: 'db-connection-failed', message: `No se pudo conectar a Postgres: ${message}` }] };
  }
}

// ---------------- Coherencia estática entre modelos ----------------

function staticChecks(models: CodeModel[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const names = new Set(models.map((m) => m.name));
  for (const m of models) {
    for (const f of m.fields) {
      if (f.ref && !names.has(f.ref)) out.push({ severity: 'high', model: m.name, field: f.name, kind: 'dangling-ref', message: `ref "${f.ref}" no corresponde a ningún modelo conocido: populate() devolverá null.`, location: `${m.file}:${f.line}` });
      if (m.orm === 'mongoose' && f.dbType === 'objectId' && !f.ref && !f.isArray) out.push({ severity: 'low', model: m.name, field: f.name, kind: 'objectid-without-ref', message: `Campo ObjectId sin ref: no se podrá hacer populate().`, location: `${m.file}:${f.line}` });
      if (m.orm === 'mongoose' && /ObjectId/.test(f.type) && f.dbType !== 'objectId' && !f.isArray) out.push({ severity: 'medium', model: m.name, field: f.name, kind: 'objectid-type-not-declared', message: `El tipo TS es ObjectId pero @Prop no declara type: Schema.Types.ObjectId; mongoose podría castearlo a otro tipo.`, location: `${m.file}:${f.line}` });
    }
    if (m.orm === 'mongoose' && !m.embedded && !m.registered) out.push({ severity: 'medium', model: m.name, kind: 'unregistered-model', message: `@Schema ${m.name} no se registra en ningún MongooseModule.forFeature.`, location: `${m.file}:${m.line}` });
  }
  return out;
}

// ---------------- dry_run_sql_query ----------------

const FORBIDDEN_SQL: Array<[RegExp, string]> = [
  [/\b(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|SAVEPOINT|RELEASE|END\s*;?\s*$|PREPARE\s+TRANSACTION|ABORT)\b/i, 'control transaccional explícito'],
  [/\bVACUUM\b/i, 'VACUUM no puede ejecutarse dentro de una transacción'],
  [/\bCONCURRENTLY\b/i, 'operaciones CONCURRENTLY no son transaccionales'],
  [/\b(CREATE|DROP|ALTER)\s+(DATABASE|TABLESPACE|SYSTEM|ROLE|USER|SUBSCRIPTION)\b/i, 'DDL global no reversible'],
  [/\bALTER\s+SYSTEM\b/i, 'ALTER SYSTEM no es reversible'],
  [/\b(COPY\b[\s\S]*\b(TO|FROM)\s+PROGRAM|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|dblink|lo_import|lo_export|pg_read_file|pg_write_file)\b/i, 'funciones con efectos fuera de la transacción'],
  [/\b(NOTIFY|LISTEN|UNLISTEN|DISCARD|CHECKPOINT|CLUSTER|REINDEX\s+(DATABASE|SYSTEM))\b/i, 'comandos con efectos fuera de la transacción'],
  [/\bSET\s+(SESSION\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b/i, 'cambio de rol de sesión'],
];

/** Elimina comentarios y literales para validar la query sin falsos positivos. */
function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

async function dryRunSql(query: string): Promise<Record<string, unknown>> {
  const stripped = stripSqlLiterals(query).trim().replace(/;\s*$/, '');
  for (const [re, reason] of FORBIDDEN_SQL) {
    if (re.test(stripped)) throw new Error(`Query rechazada: ${reason}.`);
  }
  if (stripped.includes(';')) throw new Error('Query rechazada: solo se permite una sentencia por ejecución.');

  return withPgClient(async (client) => {
    const started = Date.now();
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const result = await client.query(query);
      return {
        ok: true,
        rolledBack: true,
        command: result.command,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
        rows: result.rows.slice(0, 100),
        truncatedRows: Math.max(0, result.rows.length - 100),
        durationMs: Date.now() - started,
        note: 'La sentencia se ejecutó dentro de BEGIN … ROLLBACK: ningún cambio persiste (las secuencias sí pueden avanzar).',
      };
    } catch (error) {
      const e = error as Error & { code?: string; detail?: string; hint?: string; position?: string; constraint?: string; table?: string; column?: string };
      return { ok: false, rolledBack: true, error: e.message, sqlstate: e.code, detail: e.detail, hint: e.hint, position: e.position, constraint: e.constraint, table: e.table, column: e.column };
    } finally {
      await client.query('ROLLBACK').catch((error: unknown) => console.error('[backend-qa] Error en ROLLBACK:', error));
    }
  });
}

export function registerDbBridgeTools(server: McpServer): void {
  server.registerTool(
    'inspect_db_schema_and_models',
    {
      title: 'Inspeccionar esquema de BD y modelos',
      description:
        'Detecta el ORM del backend (Prisma, TypeORM, Mongoose/@nestjs/mongoose, Drizzle, Sequelize, pg) y extrae modelos, campos, relaciones, ' +
        'índices y constraints del código. Si hay conexión (DATABASE_URL para Postgres vía information_schema con ::text, o MONGODB_URI para Mongo), ' +
        'compara contra la base real: tablas/colecciones faltantes, columnas o campos no mapeados, tipos incompatibles, requeridos ausentes e índices únicos que no existen.',
      inputSchema: {
        include_live_db: z.boolean().optional().default(true).describe('Si es false, solo analiza el código.'),
        sample_size: z.number().int().min(1).max(1000).optional().default(50).describe('Documentos a muestrear por colección en Mongo.'),
        include_fields: z.boolean().optional().default(true).describe('Incluir el detalle de campos por modelo en la respuesta.'),
      },
    },
    safeHandler('inspect_db_schema_and_models', async ({ include_live_db, sample_size, include_fields }) => {
      const orms = detectOrms();
      const models = [...parseMongooseModels(), ...parsePrismaModels(), ...parseTypeOrmModels()];
      const discrepancies = staticChecks(models);
      const live: Record<string, unknown> = {};

      if (include_live_db ?? true) {
        if (models.some((m) => m.orm === 'mongoose') || orms.includes('mongodb (driver)')) {
          const mongo = await inspectMongoLive(models, sample_size ?? 50);
          live.mongodb = mongo.live;
          discrepancies.push(...mongo.discrepancies);
        }
        const pgUrl = getEnvVar('DATABASE_URL').value;
        if (isPostgresUrl(pgUrl)) {
          const pgResult = await inspectPostgresLive(models);
          live.postgres = pgResult.live;
          discrepancies.push(...pgResult.discrepancies);
        } else if (models.some((m) => m.orm !== 'mongoose')) {
          live.postgres = { connected: false, reason: 'Hay modelos SQL pero DATABASE_URL no está configurada.' };
        }
      }

      const order = { high: 0, medium: 1, low: 2, info: 3 };
      discrepancies.sort((a, b) => order[a.severity] - order[b.severity]);
      return jsonResult({
        backendRoot: BACKEND_ROOT,
        detectedOrms: orms,
        summary: {
          models: models.filter((m) => !m.embedded).length,
          embeddedSchemas: models.filter((m) => m.embedded).length,
          discrepancies: discrepancies.length,
          bySeverity: discrepancies.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.severity]: (acc[d.severity] ?? 0) + 1 }), {}),
        },
        discrepancies,
        live,
        models: models.map((m) => ({
          orm: m.orm,
          name: m.name,
          storage: m.storageName,
          embedded: m.embedded,
          location: `${m.file}:${m.line}`,
          timestamps: m.timestamps,
          relations: m.fields.filter((f) => f.ref).map((f) => `${f.name} → ${f.ref}${f.isArray ? '[]' : ''}`),
          indexes: m.indexes.map((i) => `${i.unique ? 'UNIQUE ' : ''}(${i.fields.join(', ')})`),
          ...(include_fields ?? true ? { fields: m.fields.map(({ line: _line, ...rest }) => rest) } : {}),
        })),
      });
    }),
  );

  server.registerTool(
    'dry_run_sql_query',
    {
      title: 'Dry-run de query SQL',
      description:
        'Ejecuta UNA sentencia SQL contra Postgres (DATABASE_URL) dentro de BEGIN … ROLLBACK para validar sintaxis, llaves foráneas, constraints ' +
        'y conversiones de tipos sin alterar datos. Rechaza COMMIT/ROLLBACK/VACUUM y cualquier operación no transaccional. ' +
        'Nota: este backend usa MongoDB; la herramienta solo aplica si existe una base Postgres.',
      inputSchema: {
        query: z.string().min(1).max(20_000).describe('Sentencia SQL única a validar.'),
      },
    },
    safeHandler('dry_run_sql_query', async ({ query }) => {
      if (!isPostgresUrl(getEnvVar('DATABASE_URL').value)) {
        return errorResult('DATABASE_URL no está configurada con una URL postgres://. Este backend usa MongoDB (MONGODB_URI); usa inspect_db_schema_and_models para inspeccionarlo.');
      }
      try {
        const result = await dryRunSql(query);
        return result.ok ? jsonResult(result) : { ...jsonResult(result), isError: true };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), { query: truncate(query, 2_000) });
      }
    }),
  );
}
