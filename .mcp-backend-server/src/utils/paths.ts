import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Carpeta del servidor MCP (.mcp-backend-server). Este archivo vive en dist/utils/. */
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/** Raíz del backend inspeccionado: el directorio padre del servidor (sobrescribible con BACKEND_ROOT). */
export const BACKEND_ROOT = path.resolve(process.env.BACKEND_ROOT ?? path.resolve(SERVER_ROOT, '..'));

/** Directorios donde nunca se permite escribir mediante apply_backend_fix. */
const WRITE_PROTECTED_DIRS = ['.git', 'node_modules', path.basename(SERVER_ROOT)];

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resuelve una ruta relativa a la raíz del backend bloqueando Path Traversal,
 * rutas absolutas, bytes nulos y enlaces simbólicos que escapen del repositorio.
 */
export function resolveBackendPath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new PathSecurityError('La ruta relativa no puede estar vacía.');
  }
  if (relativePath.includes('\0')) {
    throw new PathSecurityError('La ruta contiene bytes nulos.');
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathSecurityError(`Se esperaba una ruta relativa al backend, se recibió una absoluta: ${relativePath}`);
  }

  const resolved = path.resolve(BACKEND_ROOT, relativePath);
  if (!isInside(BACKEND_ROOT, resolved)) {
    throw new PathSecurityError(`Path Traversal bloqueado: "${relativePath}" sale de la raíz del backend.`);
  }

  // Si el destino (o su directorio padre) existe, comprobar también la ruta real para cazar symlinks.
  const realRoot = realpathSync(BACKEND_ROOT);
  const probe = existsSync(resolved) ? resolved : path.dirname(resolved);
  if (existsSync(probe) && !isInside(realRoot, realpathSync(probe))) {
    throw new PathSecurityError(`Enlace simbólico bloqueado: "${relativePath}" apunta fuera del backend.`);
  }
  return resolved;
}

/** Igual que resolveBackendPath, pero además impide escribir en directorios protegidos. */
export function resolveWritableBackendPath(relativePath: string): string {
  const resolved = resolveBackendPath(relativePath);
  const firstSegment = path.relative(BACKEND_ROOT, resolved).split(path.sep)[0];
  if (firstSegment === undefined || firstSegment === '' || WRITE_PROTECTED_DIRS.includes(firstSegment)) {
    throw new PathSecurityError(`Escritura prohibida en "${relativePath}" (directorio protegido: ${WRITE_PROTECTED_DIRS.join(', ')}).`);
  }
  return resolved;
}

/** Convierte una ruta absoluta en relativa al backend con separadores POSIX. */
export function toBackendRelative(absolutePath: string): string {
  return path.relative(BACKEND_ROOT, absolutePath).split(path.sep).join('/');
}
