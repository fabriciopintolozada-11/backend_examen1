import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Paginated } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateGroupDto, GroupsQueryDto, UpdateGroupDto } from './dto/group.dto';
import { GroupsService } from './groups.service';
import { Group } from './schemas/group.schema';

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @ApiOperation({ summary: 'Crear un grupo' })
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateGroupDto): Promise<Group> {
    return this.groupsService.create(dto);
  }

  @ApiOperation({ summary: 'Listar grupos (filtros: period, subject, teacher, day, available, active)' })
  @Get()
  findAll(@Query() query: GroupsQueryDto): Promise<Paginated<Group>> {
    return this.groupsService.findAll(query);
  }

  // Debe ir antes de ':id' para que 'mine' no se interprete como un ID
  @ApiOperation({ summary: 'Mis grupos (docente)' })
  @Roles(Role.Docente)
  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query() query: GroupsQueryDto): Promise<Paginated<Group>> {
    return this.groupsService.findMine(user.id, query);
  }

  @ApiOperation({ summary: 'Ver un grupo por ID' })
  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string): Promise<Group> {
    return this.groupsService.findOne(id);
  }

  @ApiOperation({ summary: 'Editar un grupo' })
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateGroupDto): Promise<Group> {
    return this.groupsService.update(id, dto);
  }
}
