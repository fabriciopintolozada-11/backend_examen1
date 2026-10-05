# Bugs corregidos — Backend y Base de datos

Registro de los bugs encontrados y corregidos en `backend_examen1` (rama `fabri`).
Se documentan aquí los **30 bugs del backend** y los **30 de la base de datos**: los datos viven en este repositorio (`database/*.json`).
Los 30 bugs del frontend están en `frontend_examen1/docs/BUGS.md`.

Cada bug indica **dónde estaba**, **qué se corrigió** y **cómo comprobarlo** en el sistema.

## Cómo levantar el sistema para probar

```powershell
# backend_examen1
docker compose up -d     # MongoDB en localhost:27018 (contenedor examen1-mongo)
npm install
npm run db:import        # carga database/*.json ya corregidos
npm run start:dev        # API: http://localhost:3000/api  ·  Swagger: http://localhost:3000/api/docs
# frontend_examen1
npm run dev              # http://localhost:3001
```

Usuarios de prueba (clave `Secret123!`):

| Rol | Email |
|---|---|
| Administrador | `admin@universidad.edu` |
| Docente (Laura) | `laura.lopez89@universidad.edu` |
| Estudiante (Juliana) | `juliana.herrera147@universidad.edu` |

---

## Backend (30)

### Configuración y arranque

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| B1 | [.env.example:5](../.env.example#L5) | `JWT_SECRET` vacío: la validación exige 16 caracteres y el backend no arrancaba | Se puso un valor de desarrollo de más de 16 caracteres (en `.env` local, uno aleatorio) | `npm run start:dev` arranca sin "Variables de entorno invalidas" |
| B2 | [docker-compose.yml:4](../docker-compose.yml#L4), [:7](../docker-compose.yml#L7) | El contenedor `proyecto1-mongo` chocaba con otro proyecto y se publicaba en el puerto 27017, pero la URI usa el 27018 | `container_name: examen1-mongo` y puertos `27018:27017` | `docker compose up -d` crea `examen1-mongo`; `npm run db:import` conecta |
| B3 | [docker-compose.yml:11](../docker-compose.yml#L11) | El volumen `mongo_data` estaba declarado pero no montado: los datos se perdían al recrear el contenedor | Se montó `mongo_data:/data/db` | `docker compose down` y `up -d`: los datos siguen |
| B4 | [src/main.ts:28](../src/main.ts#L28) | Leía `APP_PORT` (inexistente) con 3001 por defecto: chocaba con el frontend | Usa `PORT` con 3000 por defecto | http://localhost:3000/api/health |
| B5 | [src/main.ts:10](../src/main.ts#L10) | Prefijo global `api/v1`, pero el frontend llama a `/api/...` | `setGlobalPrefix('api')` | Cualquier pantalla del frontend carga datos |
| B6 | [src/main.ts:26](../src/main.ts#L26) | Swagger estaba en `api/doc`, distinto de lo documentado | `SwaggerModule.setup('api/docs', …)` | http://localhost:3000/api/docs |
| B7 | [src/reports/reports.module.ts:32](../src/reports/reports.module.ts#L32) | `ReportsService` comentado: Nest no podía inyectarlo y la app se caía al iniciar | Se descomentaron el import y el provider | El backend arranca; Admin → Reportes funciona |
| B29 | [package.json:39](../package.json#L39) | Los scripts `db:import`, `db:export` y `db:seed` usan `dotenv`, `mongodb` y `bson` sin declararlos: funcionaban solo porque llegaban como dependencias de otros paquetes | Se declararon las tres dependencias | `npm run db:import` en una instalación limpia |

### Autenticación y usuarios

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| B8 | [src/auth/dto/login.dto.ts:12](../src/auth/dto/login.dto.ts#L12) | El login exigía al menos 12 caracteres; la clave `Secret123!` tiene 10 | `@MinLength(8)`, igual que el resto del sistema | Login con `Secret123!` |
| B9 | [src/auth/auth.module.ts:23](../src/auth/auth.module.ts#L23) | `expiresIn: String(3600)`: un string sin unidad se interpreta como milisegundos, así que el token vencía en 3,6 s | Se pasa como número (segundos) | La sesión dura 1 hora sin volver al login |
| B10 | [src/auth/auth.module.ts:34](../src/auth/auth.module.ts#L34) | `RolesGuard` no estaba registrado: `@Roles()` no protegía nada y cualquier rol usaba endpoints de admin | Registrado como `APP_GUARD` | Swagger: `GET /reports/dashboard` con el token de Juliana devuelve 403 |
| B11 | [src/users/users.controller.ts:36](../src/users/users.controller.ts#L36) | `GET :id` estaba antes que `GET me`: `/users/me` respondía "ID invalido" y todas las pantallas daban 500 | `me` se declara antes de `:id` | Al entrar, el nombre aparece abajo en el menú |
| B12 | [src/users/users.controller.ts:27](../src/users/users.controller.ts#L27) | `@HttpCode(400)` en crear usuario: respondía error aunque se creara | Se quitó (responde 201) | Admin → Usuarios → Nuevo usuario muestra éxito |
| B13 | [src/auth/auth.service.ts:24](../src/auth/auth.service.ts#L24) | Todos los logins esperaban 5 s, incluso los correctos | Solo se frena (1 s) un intento fallido | Login correcto instantáneo; con clave errónea tarda 1 s |
| B14 | [src/users/users.service.ts:133](../src/users/users.service.ts#L133) | `changePassword` no guardaba: devolvía OK pero la clave nunca cambiaba | Usa `setPassword()`, que hace `save()` | Mi cuenta → cambiar contraseña → salir → entrar con la nueva |
| B15 | [src/users/dto/user.dto.ts:15](../src/users/dto/user.dto.ts#L15) | El campo del DTO se llamaba `namesssss`: el admin no podía editar el nombre (400 "property name should not exist") | Renombrado a `name` | Admin → Usuarios → Editar → cambiar el nombre → Guardar |
| B16 | [src/users/users.service.ts:55](../src/users/users.service.ts#L55) | La búsqueda de usuarios distinguía mayúsculas | RegExp con flag `'i'` | Admin → Usuarios → buscar "JULIANA" |
| B28 | [src/users/dto/user.dto.ts:57](../src/users/dto/user.dto.ts#L57), [notification.dto.ts:28](../src/notifications/dto/notification.dto.ts#L28) | El transform convertía cualquier valor (`active=abc`) en `false` en vez de rechazarlo | Usa `toBoolean`, como el resto de DTOs | Swagger: `GET /users?active=abc` devuelve 400 |

### Grupos, matrículas, evaluaciones y notas

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| B17 | [src/groups/groups.controller.ts:34](../src/groups/groups.controller.ts#L34) | `GET mine` estaba después de `GET :id`: `/groups/mine` daba "ID invalido" | `mine` se declara antes de `:id` | Laura → Mis grupos |
| B18 | [src/groups/groups.service.ts:98](../src/groups/groups.service.ts#L98) | `assertCanManage` comparaba con `Estudiante` en vez de `Docente`: un docente podía gestionar grupos ajenos | Compara con `Role.Docente` | Laura → `/docente/grupos/<id de un grupo ajeno>` muestra "No puedes ver este grupo" |
| B19 | [src/enrollments/enrollments.service.ts:79](../src/enrollments/enrollments.service.ts#L79) | Condición invertida: lanzaba un error justo cuando la matrícula quedaba `activa`. Ninguna matrícula funcionaba y el cupo quedaba descontado | `!==` en vez de `===` | Juliana → Matricular → botón Matricular |
| B20 | [src/enrollments/enrollments.service.ts:101](../src/enrollments/enrollments.service.ts#L101) | Cancelar una matrícula no liberaba el cupo del grupo | `$inc: { enrolled: -1 }` dentro de la transacción | Cancelar una matrícula: en Admin → Grupos, los cupos bajan |
| B21 | [src/enrollments/enrollments.controller.ts:34](../src/enrollments/enrollments.controller.ts#L34) | `GET /enrollments/mine` exigía rol `Docente`: el estudiante no veía sus matrículas | `@Roles(Role.Estudiante)` | Juliana → Mis materias |
| B22 | [src/evaluations/evaluations.controller.ts:14](../src/evaluations/evaluations.controller.ts#L14) | Ruta `evaluationslalala` | `@Controller('evaluations')` | Laura → grupo → pestaña Evaluaciones |
| B23 | [src/evaluations/evaluations.controller.ts:20](../src/evaluations/evaluations.controller.ts#L20) | `@HttpCode(BAD_REQUEST)`: crear una evaluación respondía 400 aunque se creara | Se quitó (responde 201) | Laura → Evaluaciones → Agregar muestra "Evaluación creada" |
| B24 | [src/grades/dto/grade.dto.ts:18](../src/grades/dto/grade.dto.ts#L18) | `@Max(4.5)`: no se podían poner notas entre 4.5 y 5.0 | `@Max(5)` | Laura → Notas → poner 4.8 → Guardar |
| B25 | [src/grades/grades.service.ts:132](../src/grades/grades.service.ts#L132) | `finalGrade > 3.0`: un 3.0 exacto reprobaba | `>=` | Finalizar un grupo: un 3.0 queda "Aprobada" |
| B30 | [src/periods/periods.service.ts:58](../src/periods/periods.service.ts#L58) | Se podían cambiar el código y las fechas de un periodo cerrado, aunque el cierre es irreversible | Un periodo cerrado ya no se modifica | Swagger: `PATCH /periods/<id cerrado>` devuelve 400 |

### Notificaciones y documentación

| # | Archivo corregido | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|
| B26 | [src/notifications/notifications.service.ts:70](../src/notifications/notifications.service.ts#L70) | `markRead` guardaba `readAt` pero no `read = true`: la notificación seguía sin leer | Se marca `read = true` | Notificaciones → "Marcar leída": baja el contador del menú |
| B27 | [src/deletions/deletions.controller.ts:10](../src/deletions/deletions.controller.ts#L10) | Tag de Swagger `deletions21312` | `@ApiTags('deletions')` | `/api/docs`: la sección se llama "deletions" |

---

## Base de datos (30)

Corregidos en `database/*.json`. Para aplicarlos: `npm run db:import`. Se pueden ver con MongoDB Compass en `mongodb://localhost:27018/universidad?directConnection=true`.

### Usuarios y perfiles

| # | Archivo | Registro | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|---|
| D1 | [users.json](../database/users.json) | `admin@universidad.edu` | Nombre vacío | `"Administrador"` | Admin → nombre en el menú |
| D2 | [users.json](../database/users.json) | Laura López | Email con mayúsculas (`Laura.Lopez89@…`): el login busca en minúsculas y no la encontraba | `laura.lopez89@universidad.edu` | Login de Laura |
| D3 | [users.json](../database/users.json) | Laura López | Rol `"Docente"`, fuera del enum | `"docente"` | Laura entra al área de docente |
| D4 | [users.json](../database/users.json) | Laura López | Usuaria inactiva | `active: true` | Login de Laura |
| D5 | [users.json](../database/users.json) | Juliana Herrera | Hash de contraseña cortado (le faltaba el último carácter) | Hash completo | Login de Juliana |
| D8 | [students.json](../database/students.json) | `E20210046` (Juliana) | Programa inexistente | Programa CSOC (Comunicación Social), el de sus materias | Juliana → Malla curricular |
| D9 | [students.json](../database/students.json) | `E20210046` (Juliana) | Perfil de estudiante inactivo con el usuario activo | `active: true` | Juliana → Matricular funciona |
| D10 | [faculties.json](../database/faculties.json) | `FAC-COM` | El decano apuntaba a un docente inexistente | Docente DOC-041 de la misma facultad | Swagger: `GET /faculties` |

### Catálogo y periodos

| # | Archivo | Registro | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|---|
| D6 | [periods.json](../database/periods.json) | `2026-2` | Status `"Abierto"` con mayúscula: el sistema no encontraba ningún periodo abierto | `"abierto"` | Admin → Inicio muestra el periodo 2026-2 |
| D7 | [programs.json](../database/programs.json) | `DERE` | Programa duplicado (viola el índice único de `code`) | Se eliminó el registro agregado | Admin → Programas → buscar "DERE": 1 resultado |
| D11 | [subjects.json](../database/subjects.json) | `MAT101` | Era prerrequisito de sí misma (ciclo): nadie podía cursarla | Sin prerrequisitos | Admin → Materias → MAT101 → Editar |
| D12 | [subjects.json](../database/subjects.json) | `ODON105` | 0 créditos (el mínimo es 1) | 3 créditos | Admin → Materias → ODON105 |

### Grupos y evaluaciones

| # | Archivo | Registro | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|---|
| D13 | [groups.json](../database/groups.json) | `…c3a` (MAT101 2026-2) | `enrolled` 35 con cupo 32; hay 9 matrículas reales | `enrolled: 9` | Admin → Grupos → Cálculo 1: 9 / 32 |
| D14 | [groups.json](../database/groups.json) | `…c3a` | Día `"Miércoles"` (tilde y mayúscula), fuera del enum | `"miercoles"` | Admin → Grupos → Cálculo 1: "Mié 09:00–11:00" |
| D15 | [groups.json](../database/groups.json) | `…c3a` | Salón B-104: inactivo y con capacidad 22, menor que el cupo de 32 | Salón C-104 (activo, capacidad 32, libre en ese horario) | Admin → Grupos → Cálculo 1: (C-104) |
| D16 | [groups.json](../database/groups.json) | `…c99` | La franja del miércoles usaba B-104 (inactivo, más chico que el cupo de 25) y los demás días A-305 | Miércoles en A-305, como el resto de su horario | Admin → Grupos → periodo 2026-2 |
| D17 | [groups.json](../database/groups.json) | `…c3e` (ODON105 2026-2) | `enrolled` 42 con cupo 39; hay 9 matrículas reales | `enrolled: 9` | Admin → Grupos → ODON105: 9 / 39 |
| D18 | [groups.json](../database/groups.json) | `…c64` | Franja del jueves de 09:00 a 07:00 (termina antes de empezar) | 07:00–09:00 | Admin → Grupos → filtrar periodo 2027-1 |
| D24 | [evaluations.json](../database/evaluations.json) | Grupo `…c3a` | El plan sumaba 110% (Taller 30%) | Taller 20%, como en los demás grupos (total 100%) | Admin abre `/docente/grupos/6abf0b8bfead57fb41c12c3a?tab=notas`: "Plan 100%" |

### Matrículas

| # | Archivo | Registro | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|---|
| D19 | [enrollments.json](../database/enrollments.json) | `…d25` (Juliana, CSOC128 2025-1) | `activa` con nota final 3.38 en un periodo cerrado | `aprobada` | Juliana → Historial: CSOC128 Aprobada |
| D20 | [enrollments.json](../database/enrollments.json) | `…dfb` (Juliana) | La materia (ARQU181) no era la del grupo (ODON105) | `subject` = ODON105 | Juliana → Mis materias: ODON105 |
| D21 | [enrollments.json](../database/enrollments.json) | `…e1a` (Juliana, CSOC269) | Periodo 2026-1, distinto del 2026-2 de su grupo | `period` = 2026-2 | Juliana → Mis materias: CSOC269 en 2026-2 |
| D22 | [enrollments.json](../database/enrollments.json) | `…e1a` | Cursaba CSOC269 sin el prerrequisito CSOC128 aprobado | Se resuelve con D19 (CSOC128 queda aprobada) | Juliana → Malla: CSOC128 aprobada |
| D23 | [enrollments.json](../database/enrollments.json) | `…f3c2` | Matrícula duplicada (mismo estudiante y grupo; viola el índice único) | Se eliminó | Juliana → Mis materias: ODON105 una sola vez |

### Notas y notificaciones

| # | Archivo | Registro | Bug | Corrección | Cómo verlo |
|---|---|---|---|---|---|
| D25 | [grades.json](../database/grades.json) | `…df0` | Nota 5.7 (la escala es de 0 a 5) | 5.0 | Admin → planilla del grupo `…c3a` |
| D26 | [grades.json](../database/grades.json) | `…dfc` (Juliana, ODON105) | Nota 5.7 | 5.0 | Juliana → Notas → ODON105 Parcial 1 |
| D27 | [grades.json](../database/grades.json) | `…dfd` (Juliana, ODON105) | La evaluación pertenecía a otro grupo | Parcial 2 del grupo correcto | Juliana → Notas → ODON105 Parcial 2: 3.6 |
| D28 | [grades.json](../database/grades.json) | `…e1b` (Juliana, CSOC269) | Valor guardado como texto `"4,2"` | Número `4.2` | Juliana → Notas → CSOC269 Parcial 1: 4.2 |
| D29 | [notifications.json](../database/notifications.json) | `…eb7` (Juliana) | Tipo `aviso_urgente`, fuera del enum | `matricula_confirmada` (coincide con su título) | Juliana → Notificaciones |
| D30 | [grades.json](../database/grades.json) | 47 notas | `createdAt` en el futuro, posterior a `updatedAt` | `createdAt` = `updatedAt` | Compass: `db.grades.find({$expr:{$gt:["$createdAt","$updatedAt"]}})` devuelve 0 |

---

## Verificación realizada

- `npx tsc --noEmit`: sin errores.
- Script de integridad sobre los 13 JSON (referencias, enums, rangos, cupos, cruces de horario, índices únicos, planes de evaluación, coherencia de notas): sin hallazgos.
- Pruebas de punta a punta contra la API (login, permisos, matricular y cancelar, cupos, notas, evaluaciones, contraseña, notificaciones): todas pasan.
