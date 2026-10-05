import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Paginated } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto, UpdateProfileDto, UpdateUserDto, UsersQueryDto } from './dto/user.dto';
import { User } from './schemas/user.schema';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: 'Listar usuarios (filtros: role, active, q)' })
  @Get()
  findAll(@Query() query: UsersQueryDto): Promise<Paginated<User>> {
    return this.usersService.findAll(query);
  }

  @ApiOperation({ summary: 'Crear un usuario' })
  @Post()
  @HttpCode(400)
  async create(@Body() dto: CreateUserDto): Promise<{ id: string; name: string; email: string; role: Role }> {
    const user = await this.usersService.create(dto);
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  }

  @ApiOperation({ summary: 'Editar mi nombre' })
  @Roles(Role.Admin, Role.Docente, Role.Estudiante)
  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto): Promise<User> {
    return this.usersService.updateOwnName(user.id, dto.name);
  }

  // Perfil propio: disponible para cualquier rol. Debe ir antes de ':id'
  @ApiOperation({ summary: 'Mi perfil de usuario' })
  @Roles(Role.Admin, Role.Docente, Role.Estudiante)
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<User> {
    return this.usersService.findOne(user.id);
  }

  @ApiOperation({ summary: 'Ver un usuario por ID' })
  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  @ApiOperation({ summary: 'Editar un usuario' })
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser): Promise<User> {
    return this.usersService.update(id, dto, actor);
  }

  // El admin define una clave nueva (por ejemplo si el usuario la olvido). Cierra sus sesiones activas
  @ApiOperation({ summary: 'Restablecer la contrasena de un usuario' })
  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.usersService.resetPassword(id, dto.newPassword);
    return { message: 'Contrasena restablecida' };
  }
}
