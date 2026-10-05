import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Paginated } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateEnrollmentDto, EnrollmentsQueryDto } from './dto/enrollment.dto';
import { EnrollmentsService } from './enrollments.service';
import { Enrollment } from './schemas/enrollment.schema';

@ApiTags('enrollments')
@ApiBearerAuth()
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @ApiOperation({ summary: 'Matricular en un grupo (valida cupo, prerrequisitos, cruces de horario y creditos)' })
  @Roles(Role.Admin, Role.Estudiante)
  @Post()
  enroll(@Body() dto: CreateEnrollmentDto, @CurrentUser() user: AuthUser): Promise<Enrollment> {
    return this.enrollmentsService.enroll(dto, user);
  }

  @ApiOperation({ summary: 'Listar matriculas' })
  @Roles(Role.Admin)
  @Get()
  findAll(@Query() query: EnrollmentsQueryDto): Promise<Paginated<Enrollment>> {
    return this.enrollmentsService.findAll(query);
  }

  // Debe ir antes de ':id' para que 'mine' no se interprete como un ID
  @ApiOperation({ summary: 'Mis matriculas' })
  @Roles(Role.Estudiante)
  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query() query: EnrollmentsQueryDto): Promise<Paginated<Enrollment>> {
    return this.enrollmentsService.findMine(user.id, query);
  }

  @ApiOperation({ summary: 'Ver una matricula por ID' })
  @Roles(Role.Admin, Role.Estudiante)
  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<Enrollment> {
    return this.enrollmentsService.findOne(id, user);
  }

  @ApiOperation({ summary: 'Cancelar una matricula activa (libera el cupo)' })
  @Roles(Role.Admin, Role.Estudiante)
  @Post(':id/cancel')
  cancel(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<Enrollment> {
    return this.enrollmentsService.cancel(id, user);
  }
}
