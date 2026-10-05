import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, PopulateOptions } from 'mongoose';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { ClassroomsService } from '../classrooms/classrooms.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { PeriodsService } from '../periods/periods.service';
import { PeriodStatus } from '../periods/schemas/period.schema';
import { SubjectsService } from '../subjects/subjects.service';
import { TeachersService } from '../teachers/teachers.service';
import { CreateGroupDto, GroupsQueryDto, ScheduleSlotDto, UpdateGroupDto } from './dto/group.dto';
import { slotsOverlap } from './schedule.util';
import { Group, GroupDocument } from './schemas/group.schema';

const POPULATE: PopulateOptions[] = [
  { path: 'subject', select: 'code name credits' },
  { path: 'period', select: 'code status' },
  { path: 'teacher', select: 'code user', populate: { path: 'user', select: 'name' } },
  { path: 'schedule.classroom', select: 'code building floor type capacity' },
];

const overlaps = slotsOverlap;

@Injectable()
export class GroupsService {
  constructor(
    @InjectModel(Group.name) private readonly model: Model<GroupDocument>,
    private readonly subjectsService: SubjectsService,
    private readonly teachersService: TeachersService,
    private readonly periodsService: PeriodsService,
    private readonly classroomsService: ClassroomsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async create(dto: CreateGroupDto): Promise<GroupDocument> {
    const subject = await this.subjectsService.findOne(dto.subject);
    if (!subject.active) throw new BadRequestException('La materia esta inactiva');

    const teacher = await this.assertTeacherActive(dto.teacher);

    const period = await this.periodsService.findOne(dto.period);
    if (period.status === PeriodStatus.Closed) {
      throw new BadRequestException('No se pueden crear grupos en un periodo cerrado');
    }

    this.assertValidSchedule(dto.schedule);
    await this.classroomsService.assertActive(dto.schedule.map((s) => s.classroom));
    await this.assertNoConflicts(dto.period, dto.teacher, dto.schedule);

    const last = await this.model
      .findOne({ subject: dto.subject, period: dto.period })
      .sort({ number: -1 })
      .select('number')
      .exec();

    const group = await this.model.create({ ...dto, number: (last?.number ?? 0) + 1, enrolled: 0 });
    await this.notifyAssigned(teacher.user, group, subject.name, period.code);
    return group;
  }

  async findAll(query: GroupsQueryDto, forcedTeacher?: string): Promise<Paginated<Group>> {
    const filter: FilterQuery<GroupDocument> = {};
    if (query.period) filter.period = query.period;
    if (query.subject) filter.subject = query.subject;
    const teacher = forcedTeacher ?? query.teacher;
    if (teacher) filter.teacher = teacher;
    if (query.active !== undefined) filter.active = query.active;
    if (query.day) filter['schedule.day'] = query.day;
    if (query.available) {
      filter.active = true;
      filter.$expr = { $lt: ['$enrolled', '$capacity'] };
    }

    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ period: -1, number: 1 }).skip(query.skip).limit(query.limit).populate(POPULATE).exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return paginate(data, total, query);
  }

  async findMine(userId: string, query: GroupsQueryDto): Promise<Paginated<Group>> {
    const teacher = await this.teachersService.findByUserId(userId);
    return this.findAll(query, teacher.id);
  }

  async findOne(id: string): Promise<GroupDocument> {
    const group = await this.model.findById(id).populate(POPULATE).exec();
    if (!group) throw new NotFoundException('Grupo no encontrado');
    return group;
  }

  // El admin gestiona cualquier grupo; un docente solo los que tiene a su cargo
  async assertCanManage(groupId: string, user: AuthUser): Promise<GroupDocument> {
    const group = await this.findRaw(groupId);
    if (user.role === Role.Docente) {
      const teacher = await this.teachersService.findByUserId(user.id);
      if (String(group.teacher) !== teacher.id) throw new ForbiddenException('El grupo no esta a tu cargo');
    }
    return group;
  }

  // Sin populate: para validaciones internas de otros modulos (matriculas, notas)
  async findRaw(id: string): Promise<GroupDocument> {
    const group = await this.model.findById(id).exec();
    if (!group) throw new NotFoundException('Grupo no encontrado');
    return group;
  }

  async update(id: string, dto: UpdateGroupDto): Promise<GroupDocument> {
    const group = await this.model.findById(id).exec();
    if (!group) throw new NotFoundException('Grupo no encontrado');

    if (dto.capacity !== undefined && dto.capacity < group.enrolled) {
      throw new BadRequestException(`El cupo no puede ser menor a los ${group.enrolled} estudiantes matriculados`);
    }

    const teacherId = dto.teacher ?? String(group.teacher);
    const schedule = dto.schedule ?? (group.schedule as unknown as ScheduleSlotDto[]);
    const newTeacher = dto.teacher && dto.teacher !== String(group.teacher) ? await this.assertTeacherActive(dto.teacher) : null;
    if (dto.schedule) {
      this.assertValidSchedule(dto.schedule);
      await this.classroomsService.assertActive(dto.schedule.map((s) => s.classroom));
    }
    if (dto.teacher || dto.schedule) {
      await this.assertNoConflicts(String(group.period), teacherId, schedule, id);
    }

    group.set(dto);
    await group.save();

    if (newTeacher) {
      const [subject, period] = await Promise.all([
        this.subjectsService.findOne(String(group.subject)),
        this.periodsService.findOne(String(group.period)),
      ]);
      await this.notifyAssigned(newTeacher.user, group, subject.name, period.code);
    }
    return this.findOne(id);
  }

  private async assertTeacherActive(teacherId: string) {
    const teacher = await this.teachersService.findOne(teacherId);
    if (!teacher.active) throw new BadRequestException('El docente esta inactivo');
    return teacher;
  }

  private notifyAssigned(teacherUser: unknown, group: GroupDocument, subjectName: string, periodCode: string): Promise<void> {
    return this.notificationsService.notify(
      teacherUser,
      NotificationType.GroupAssigned,
      'Grupo asignado',
      `Se te asigno el grupo ${group.number} de ${subjectName} (periodo ${periodCode}).`,
      { model: 'Group', id: group._id },
    );
  }

  // Cada franja debe terminar despues de iniciar y no solaparse con otra del mismo grupo
  private assertValidSchedule(schedule: ScheduleSlotDto[]): void {
    schedule.forEach((s) => {
      if (s.endTime <= s.startTime) {
        throw new BadRequestException(`La franja del ${s.day} debe terminar despues de iniciar`);
      }
    });
    for (let i = 0; i < schedule.length; i++) {
      for (let j = i + 1; j < schedule.length; j++) {
        if (overlaps(schedule[i], schedule[j])) {
          throw new BadRequestException('Las franjas del grupo se solapan entre si');
        }
      }
    }
  }

  // Un docente no puede dictar dos grupos a la vez, ni dos grupos usar el mismo salon a la vez (mismo periodo)
  private async assertNoConflicts(
    period: string,
    teacher: string,
    schedule: ScheduleSlotDto[],
    excludeId?: string,
  ): Promise<void> {
    const rooms = schedule.map((s) => String(s.classroom));
    const others = await this.model
      .find({
        period,
        active: true,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        $or: [{ teacher }, { 'schedule.classroom': { $in: rooms } }],
      })
      .exec();

    for (const other of others) {
      for (const a of schedule) {
        for (const b of other.schedule as unknown as ScheduleSlotDto[]) {
          if (!overlaps(a, b)) continue;
          if (String(other.teacher) === teacher) {
            throw new ConflictException(`El docente ya tiene clase el ${a.day} de ${b.startTime} a ${b.endTime}`);
          }
          if (String(a.classroom) === String(b.classroom)) {
            const code = await this.classroomsService.codeOf(String(a.classroom));
            throw new ConflictException(`El salon ${code} esta ocupado el ${a.day} de ${b.startTime} a ${b.endTime}`);
          }
        }
      }
    }
  }
}
