import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { FilterQuery, Model } from 'mongoose';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { Student, StudentDocument } from '../students/schemas/student.schema';
import { Teacher, TeacherDocument } from '../teachers/schemas/teacher.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto, UsersQueryDto } from './dto/user.dto';
import { User, UserDocument } from './schemas/user.schema';

const SALT_ROUNDS = 10;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    // Para saber si un usuario ya tiene perfil (no se inyectan sus servicios: evita ciclos de modulos)
    @InjectModel(Student.name) private readonly studentModel: Model<StudentDocument>,
    @InjectModel(Teacher.name) private readonly teacherModel: Model<TeacherDocument>,
    private readonly config: ConfigService,
  ) {}

  // Crea el primer administrador si no existe ninguno
  async onModuleInit(): Promise<void> {
    if (await this.userModel.exists({ role: Role.Admin })) return;

    const email = this.config.getOrThrow<string>('ADMIN_EMAIL');
    const password = this.config.getOrThrow<string>('ADMIN_PASSWORD');
    await this.create({ name: 'Administrador', email, password, role: Role.Admin });
    this.logger.log(`Administrador inicial creado: ${email}`);
  }

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    return this.userModel.create({
      name: dto.name,
      email: dto.email,
      role: dto.role ?? Role.Estudiante,
      passwordHash,
    });
  }

  async findAll(query: UsersQueryDto): Promise<Paginated<User>> {
    const filter: FilterQuery<UserDocument> = {};
    if (query.role) filter.role = query.role;
    if (query.active !== undefined) filter.active = query.active;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q.trim()), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const [data, total] = await Promise.all([
      this.userModel.find(filter).sort({ createdAt: -1 }).skip(query.skip).limit(query.limit).exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return paginate(data, total, query);
  }

  findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  // IDs de los usuarios de un rol cuyo nombre o correo contiene el texto (para buscar estudiantes/docentes por nombre)
  async findIdsByText(text: string, role: Role): Promise<UserDocument['_id'][]> {
    const pattern = new RegExp(escapeRegex(text.trim()), 'i');
    return this.userModel.find({ role, $or: [{ name: pattern }, { email: pattern }] }).distinct('_id');
  }

  async findOne(id: string): Promise<UserDocument> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  // Edicion por el administrador, con las protecciones que evitan dejar el sistema sin acceso
  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<UserDocument> {
    const user = await this.findOne(id);
    const roleChanges = dto.role !== undefined && dto.role !== user.role;

    if (id === actor.id) {
      if (dto.active === false) throw new BadRequestException('No puedes desactivar tu propia cuenta');
      if (roleChanges) throw new BadRequestException('No puedes cambiar tu propio rol');
    }

    // El rol debe seguir coincidiendo con el perfil (student / teacher) que ya tenga
    if (roleChanges) {
      if (await this.studentModel.exists({ user: user._id })) {
        throw new ConflictException('El usuario tiene perfil de estudiante: no se puede cambiar su rol');
      }
      if (await this.teacherModel.exists({ user: user._id })) {
        throw new ConflictException('El usuario tiene perfil de docente: no se puede cambiar su rol');
      }
    }

    // Siempre debe quedar al menos un administrador activo
    const loosesAdmin = user.role === Role.Admin && ((roleChanges && dto.role !== Role.Admin) || dto.active === false);
    if (loosesAdmin) {
      const others = await this.userModel.countDocuments({ role: Role.Admin, active: true, _id: { $ne: user._id } }).exec();
      if (others === 0) throw new ConflictException('Debe existir al menos un administrador activo');
    }

    user.set(dto);
    return user.save();
  }

  async updateOwnName(userId: string, name: string): Promise<UserDocument> {
    const user = await this.findOne(userId);
    user.name = name;
    return user.save();
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).select('+passwordHash').exec();
    if (!user) throw new NotFoundException('Usuario no encontrado');

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException('La contrasena actual es incorrecta');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException('La nueva contrasena debe ser distinta de la actual');
    }
    return this.setPassword(user, newPassword);
  }

  async resetPassword(id: string, newPassword: string): Promise<void> {
    const user = await this.userModel.findById(id).select('+passwordHash').exec();
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.setPassword(user, newPassword);
  }

  // Guarda la nueva clave e invalida las sesiones (tokens) anteriores
  private async setPassword(user: UserDocument, newPassword: string): Promise<UserDocument> {
    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.passwordChangedAt = new Date();
    return user.save();
  }
}
