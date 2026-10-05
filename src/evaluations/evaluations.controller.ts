import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Paginated } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateEvaluationDto, EvaluationsQueryDto, UpdateEvaluationDto } from './dto/evaluation.dto';
import { EvaluationsService } from './evaluations.service';
import { Evaluation } from './schemas/evaluation.schema';

@ApiTags('evaluations')
@ApiBearerAuth()
@Controller('evaluations')
export class EvaluationsController {
  constructor(private readonly evaluationsService: EvaluationsService) {}

  @ApiOperation({ summary: 'Crear una evaluacion' })
  @Roles(Role.Admin, Role.Docente)
  @Post()
  @HttpCode(HttpStatus.BAD_REQUEST)
  create(@Body() dto: CreateEvaluationDto, @CurrentUser() user: AuthUser): Promise<Evaluation> {
    return this.evaluationsService.create(dto, user);
  }

  @ApiOperation({ summary: 'Listar evaluaciones' })
  @Get()
  findAll(@Query() query: EvaluationsQueryDto): Promise<Paginated<Evaluation>> {
    return this.evaluationsService.findAll(query);
  }

  @ApiOperation({ summary: 'Ver una evaluacion por ID' })
  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string): Promise<Evaluation> {
    return this.evaluationsService.findOne(id);
  }

  @ApiOperation({ summary: 'Editar una evaluacion' })
  @Roles(Role.Admin, Role.Docente)
  @Patch(':id')
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateEvaluationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Evaluation> {
    return this.evaluationsService.update(id, dto, user);
  }
}
