import { Controller, Delete, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { DeletionsService, Deleted } from './deletions.service';

// Eliminacion segura: se rechaza (409) si otros registros dependen del que se quiere borrar
@ApiTags('deletions')
@ApiBearerAuth()
@Controller()
export class DeletionsController {
  constructor(private readonly deletionsService: DeletionsService) {}

  @ApiOperation({ summary: 'Elimina un grupo sin matriculas ni evaluaciones' })
  @Roles(Role.Admin)
  @Delete('groups/:id')
  group(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeGroup(id);
  }

  @ApiOperation({ summary: 'Elimina una evaluacion sin notas registradas' })
  @Roles(Role.Admin, Role.Docente)
  @Delete('evaluations/:id')
  evaluation(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<Deleted> {
    return this.deletionsService.removeEvaluation(id, user);
  }

  @ApiOperation({ summary: 'Elimina una nota puesta por error (matricula activa)' })
  @Roles(Role.Admin, Role.Docente)
  @Delete('grades/:id')
  grade(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<Deleted> {
    return this.deletionsService.removeGrade(id, user);
  }

  @ApiOperation({ summary: 'Elimina una de mis notificaciones' })
  @Delete('notifications/:id')
  notification(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<Deleted> {
    return this.deletionsService.removeNotification(id, user.id);
  }

  @ApiOperation({ summary: 'Elimina un salon que no este en ningun horario' })
  @Roles(Role.Admin)
  @Delete('classrooms/:id')
  classroom(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeClassroom(id);
  }

  @ApiOperation({ summary: 'Elimina una facultad sin programas ni docentes' })
  @Roles(Role.Admin)
  @Delete('faculties/:id')
  faculty(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeFaculty(id);
  }

  @ApiOperation({ summary: 'Elimina un programa sin materias ni estudiantes' })
  @Roles(Role.Admin)
  @Delete('programs/:id')
  program(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeProgram(id);
  }

  @ApiOperation({ summary: 'Elimina una materia sin grupos, matriculas ni dependientes' })
  @Roles(Role.Admin)
  @Delete('subjects/:id')
  subject(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeSubject(id);
  }

  @ApiOperation({ summary: 'Elimina un periodo planificado sin grupos' })
  @Roles(Role.Admin)
  @Delete('periods/:id')
  period(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removePeriod(id);
  }

  @ApiOperation({ summary: 'Elimina un estudiante sin matriculas' })
  @Roles(Role.Admin)
  @Delete('students/:id')
  student(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeStudent(id);
  }

  @ApiOperation({ summary: 'Elimina un docente sin grupos' })
  @Roles(Role.Admin)
  @Delete('teachers/:id')
  teacher(@Param('id', ParseObjectIdPipe) id: string): Promise<Deleted> {
    return this.deletionsService.removeTeacher(id);
  }

  @ApiOperation({ summary: 'Elimina un usuario sin perfil de estudiante/docente' })
  @Roles(Role.Admin)
  @Delete('users/:id')
  user(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() actor: AuthUser): Promise<Deleted> {
    return this.deletionsService.removeUser(id, actor);
  }
}
