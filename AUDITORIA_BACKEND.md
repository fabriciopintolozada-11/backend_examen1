# Auditoría de Backend — Gestión Académica

- **Fecha:** 2026-10-05 17:55:26 UTC
- **Rama / commit:** `qa/backend-julio` @ `edd8a7d`
- **Generado por:** Claude Code + backend-qa-server (MCP)
- **Bugs reportados:** 16 — ✅ PASS: 16 · ❌ FAIL: 0 · ⏳ Pendientes: 0

## Resumen ejecutivo

Auditoría ejecutada con el servidor MCP backend-qa (inspect_db_schema_and_models, inspect_env_variables, run_backend_linter_and_typecheck, run_backend_tests, http_request_endpoint, audit_error_handling).

- **Typecheck:** `tsc --noEmit` PASS (0 errores) antes y después de los parches.
- **Tests:** el proyecto **no tiene pruebas automatizadas** (Jest instalado, 0 archivos *.spec.ts); la verificación PASS de cada bug se basa en typecheck + re-escaneo de datos + endpoints, no en tests unitarios.
- **Lint:** ESLint 9 instalado sin eslint.config.*, `npm run lint` falla.
- **Datos:** las correcciones están en `database/*.json`; para aplicarlas a Mongo local hay que ejecutar `npm run db:import` y reiniciar la API (para que Mongoose cree el índice único de enrollments).
- Correcciones previas del equipo ya presentes en el árbol de trabajo (prefijo /api, puerto PORT, ReportsService registrado, rutas /me y /mine antes de :id, @Controller('evaluations'), expiresIn) no se incluyen aquí.

## Tabla de hallazgos

| ID | Severidad | Capa | Ubicación | Síntoma | Verificación |
|----|-----------|------|-----------|---------|--------------|
| BUG-BE-01 | Alta | Autenticación/Middleware | `src/auth/auth.service.ts:18` | Todo login (válido o no) tardaba ~5 s (medido con http_request_endpoint: 5108 ms). | ✅ PASS |
| BUG-BE-02 | Media | Service/Lógica | `src/reports/reports.service.ts:70` | GET /reports/dashboard devolvía currentPeriod: null ante cualquier error de BD. | ✅ PASS |
| BUG-BE-03 | Baja | Controller | `src/main.ts:26` | Swagger en /api/doc mientras el README documenta /api/docs (404). | ✅ PASS |
| BUG-BE-04 | Alta | ORM/DB | `database/users.json (Laura.Lopez89)` | El docente de prueba del README no podía iniciar sesión (401). | ✅ PASS |
| BUG-BE-05 | Alta | ORM/DB | `database/users.json (juliana.herrera147)` | La estudiante de prueba no podía iniciar sesión con Secret123!. | ✅ PASS |
| BUG-BE-06 | Baja | ORM/DB | `database/users.json (admin)` | /users/me devolvía name "" para el administrador. | ✅ PASS |
| BUG-BE-07 | Alta | ORM/DB | `database/periods.json` | /periods/current → 404 "No hay un periodo abierto"; dashboard sin periodo. | ✅ PASS |
| BUG-BE-08 | Alta | ORM/DB | `database/enrollments.json; src/enrollments/schemas/enrollment.schema.ts:41` | inspect_db_schema_and_models: índice único {student, group} inexistente en Mongo. | ✅ PASS |
| BUG-BE-09 | Media | ORM/DB | `database/programs.json` | Dos programas con code DERE. | ✅ PASS |
| BUG-BE-10 | Alta | ORM/DB | `database/students.json (E20210046)` | populate de program devolvía null. | ✅ PASS |
| BUG-BE-11 | Media | ORM/DB | `database/faculties.json (Comunicación)` | populate de dean devolvía null. | ✅ PASS |
| BUG-BE-12 | Alta | ORM/DB | `database/grades.json; src/grades/schemas/grade.schema.ts:17` | Nota "4,2" tipo string (type-mismatch) y dos notas 5.7. | ✅ PASS |
| BUG-BE-13 | Alta | ORM/DB | `database/groups.json` | Grupos con enrolled > capacity (35/32, 42/39), day "Miércoles", horario 09:00–07:00. | ✅ PASS |
| BUG-BE-14 | Media | ORM/DB | `database/subjects.json` | MAT101 era prerrequisito de sí misma; ODON105 con 0 créditos. | ✅ PASS |
| BUG-BE-15 | Media | ORM/DB | `database/evaluations.json` | Pesos del grupo 6abf…c3a suman 110%. | ✅ PASS |
| BUG-BE-16 | Media | Config/Env | `.env.example:2 vs docker-compose.yml` | Con cp .env.example .env la API no conecta a Mongo. | ✅ PASS |

### Distribución por capa

- **Controller:** 1
- **Service/Lógica:** 1
- **ORM/DB:** 12
- **Autenticación/Middleware:** 1
- **Config/Env:** 1

## Detalle de bugs

### BUG-BE-01 — Login lento de 5 s

| Campo | Valor |
|---|---|
| Capa | Autenticación/Middleware |
| Severidad | Alta |
| Ubicación | `src/auth/auth.service.ts:18` |
| Verificación | **PASS** |

**Síntoma**

> Todo login (válido o no) tardaba ~5 s (medido con http_request_endpoint: 5108 ms).

**Causa raíz**

> slowDownAttempts() hacía setTimeout(5000) incondicional antes de validar credenciales.

**Corrección aplicada**

> Eliminado el sleep fijo; la protección anti fuerza bruta debe hacerse con rate limiting.

### BUG-BE-02 — catch vacío en tablero

| Campo | Valor |
|---|---|
| Capa | Service/Lógica |
| Severidad | Media |
| Ubicación | `src/reports/reports.service.ts:70` |
| Verificación | **PASS** |

**Síntoma**

> GET /reports/dashboard devolvía currentPeriod: null ante cualquier error de BD.

**Causa raíz**

> catch vacío pensado para "sin periodo abierto" tragaba también errores de agregación/conexión.

**Corrección aplicada**

> El catch solo ignora NotFoundException y relanza el resto.

### BUG-BE-03 — Ruta de Swagger

| Campo | Valor |
|---|---|
| Capa | Controller |
| Severidad | Baja |
| Ubicación | `src/main.ts:26` |
| Verificación | **PASS** |

**Síntoma**

> Swagger en /api/doc mientras el README documenta /api/docs (404).

**Causa raíz**

> Ruta de SwaggerModule.setup desalineada con la documentación.

**Corrección aplicada**

> SwaggerModule.setup("api/docs", …).

### BUG-BE-04 — Docente de prueba sin acceso

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/users.json (Laura.Lopez89)` |
| Verificación | **PASS** |

**Síntoma**

> El docente de prueba del README no podía iniciar sesión (401).

**Causa raíz**

> Email con mayúsculas (login busca en minúsculas), role "Docente" fuera del enum y active:false.

**Corrección aplicada**

> Email normalizado, role docente, active true.

### BUG-BE-05 — Estudiante de prueba sin acceso

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/users.json (juliana.herrera147)` |
| Verificación | **PASS** |

**Síntoma**

> La estudiante de prueba no podía iniciar sesión con Secret123!.

**Causa raíz**

> passwordHash distinto al del resto de usuarios de prueba.

**Corrección aplicada**

> Hash reemplazado por el de Secret123!.

### BUG-BE-06 — Admin sin nombre

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Baja |
| Ubicación | `database/users.json (admin)` |
| Verificación | **PASS** |

**Síntoma**

> /users/me devolvía name "" para el administrador.

**Causa raíz**

> Seed con nombre vacío (schema exige required).

**Corrección aplicada**

> name = "Administrador".

### BUG-BE-07 — Periodo abierto no reconocido

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/periods.json` |
| Verificación | **PASS** |

**Síntoma**

> /periods/current → 404 "No hay un periodo abierto"; dashboard sin periodo.

**Causa raíz**

> status "Abierto" no coincide con el enum PeriodStatus.Open = "abierto".

**Corrección aplicada**

> status normalizado a "abierto".

### BUG-BE-08 — Matrícula duplicada

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/enrollments.json; src/enrollments/schemas/enrollment.schema.ts:41` |
| Verificación | **PASS** |

**Síntoma**

> inspect_db_schema_and_models: índice único {student, group} inexistente en Mongo.

**Causa raíz**

> Matrícula duplicada (mismo estudiante y grupo) hizo fallar la creación del índice único.

**Corrección aplicada**

> Eliminado el duplicado 6ac057b2…f3c2.

### BUG-BE-09 — Programa duplicado

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Media |
| Ubicación | `database/programs.json` |
| Verificación | **PASS** |

**Síntoma**

> Dos programas con code DERE.

**Causa raíz**

> Documento duplicado viola el índice único de code.

**Corrección aplicada**

> Eliminado el duplicado sin referencias.

### BUG-BE-10 — Referencia rota student.program

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/students.json (E20210046)` |
| Verificación | **PASS** |

**Síntoma**

> populate de program devolvía null.

**Causa raíz**

> Referencia a un programa inexistente.

**Corrección aplicada**

> Asignado el programa de la materia de su grupo.

### BUG-BE-11 — Referencia rota faculty.dean

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Media |
| Ubicación | `database/faculties.json (Comunicación)` |
| Verificación | **PASS** |

**Síntoma**

> populate de dean devolvía null.

**Causa raíz**

> dean apuntaba a un docente inexistente.

**Corrección aplicada**

> Asignado DOC-041 de esa facultad.

### BUG-BE-12 — Notas inválidas

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/grades.json; src/grades/schemas/grade.schema.ts:17` |
| Verificación | **PASS** |

**Síntoma**

> Nota "4,2" tipo string (type-mismatch) y dos notas 5.7.

**Causa raíz**

> Valores fuera del contrato (number 0–5).

**Corrección aplicada**

> 4,2 → 4.2; 5.7 → 5 (máximo permitido).

### BUG-BE-13 — Grupos inconsistentes

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Alta |
| Ubicación | `database/groups.json` |
| Verificación | **PASS** |

**Síntoma**

> Grupos con enrolled > capacity (35/32, 42/39), day "Miércoles", horario 09:00–07:00.

**Causa raíz**

> Contadores desincronizados con matrículas activas reales; enum Day y horario inválidos.

**Corrección aplicada**

> enrolled = matrículas activas (9 y 9), day "miercoles", horario 07:00–09:00.

### BUG-BE-14 — Materias inválidas

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Media |
| Ubicación | `database/subjects.json` |
| Verificación | **PASS** |

**Síntoma**

> MAT101 era prerrequisito de sí misma; ODON105 con 0 créditos.

**Causa raíz**

> Datos que violan la lógica de prerrequisitos y min: 1 del schema.

**Corrección aplicada**

> Quitado el auto-prerrequisito; créditos = 3.

### BUG-BE-15 — Pesos de evaluaciones

| Campo | Valor |
|---|---|
| Capa | ORM/DB |
| Severidad | Media |
| Ubicación | `database/evaluations.json` |
| Verificación | **PASS** |

**Síntoma**

> Pesos del grupo 6abf…c3a suman 110%.

**Causa raíz**

> Taller con 30% en lugar de 20%.

**Corrección aplicada**

> Taller = 20% (total 100%).

### BUG-BE-16 — Puerto Mongo en .env.example

| Campo | Valor |
|---|---|
| Capa | Config/Env |
| Severidad | Media |
| Ubicación | `.env.example:2 vs docker-compose.yml` |
| Verificación | **PASS** |

**Síntoma**

> Con cp .env.example .env la API no conecta a Mongo.

**Causa raíz**

> MONGODB_URI usa el puerto 27018 y docker-compose publica 27017.

**Corrección aplicada**

> MONGODB_URI en .env.example cambiado a localhost:27017.

---

_Reporte generado automáticamente por la herramienta `generate_backend_bug_report` del servidor MCP backend-qa._
