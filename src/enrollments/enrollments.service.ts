import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, PopulateOptions, Types } from 'mongoose';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { Role } from '../common/enums/role.enum';
import { slotsOverlap } from '../groups/schedule.util';
import { GroupsService } from '../groups/groups.service';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { PeriodsService } from '../periods/periods.service';
import { PeriodStatus } from '../periods/schemas/period.schema';
import { StudentsService } from '../students/students.service';
import { SubjectsService } from '../subjects/subjects.service';
import { SubjectDocument } from '../subjects/schemas/subject.schema';
import { CreateEnrollmentDto, EnrollmentsQueryDto } from './dto/enrollment.dto';
import { Enrollment, EnrollmentDocument, EnrollmentStatus } from './schemas/enrollment.schema';

// Limite de creditos que un estudiante puede cursar en un mismo periodo
export const MAX_CREDITS_PER_PERIOD = 20;

// Estados que ocupan un cupo / cuentan como "cursada" (todo menos cancelada)
const OCCUPYING = [EnrollmentStatus.Active, EnrollmentStatus.Passed, EnrollmentStatus.Failed];

const POPULATE: PopulateOptions[] = [
  { path: 'student', select: 'code user', populate: { path: 'user', select: 'name' } },
  { path: 'subject', select: 'code name credits' },
  { path: 'group', select: 'number' },
  { path: 'period', select: 'code status' },
];

@Injectable()
export class EnrollmentsService {
  constructor(
    @InjectModel(Enrollment.name) private readonly model: Model<EnrollmentDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly studentsService: StudentsService,
    private readonly groupsService: GroupsService,
    private readonly subjectsService: SubjectsService,
    private readonly periodsService: PeriodsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async enroll(dto: CreateEnrollmentDto, user: AuthUser): Promise<EnrollmentDocument> {
    const student = await this.resolveStudent(dto.student, user);
    if (!student.active) throw new BadRequestException('El estudiante esta inactivo');

    const group = await this.groupsService.findRaw(dto.groupId);
    if (!group.active) throw new BadRequestException('El grupo esta inactivo');

    const period = await this.periodsService.findOne(String(group.period));
    if (period.status !== PeriodStatus.Open) {
      throw new BadRequestException('Solo se puede matricular en un periodo abierto');
    }
    const subject = await this.subjectsService.findOne(String(group.subject));

    const cancelled = await this.assertNotDuplicated(student.id, group, subject);
    await this.assertPrerequisites(student.id, subject);
    await this.assertNoScheduleConflict(student.id, group);
    await this.assertCreditLimit(student.id, group, subject);

    const created = await this.reserveSeat(student.id, group, subject, cancelled);
    await this.notificationsService.notify(
      student.user,
      NotificationType.EnrollmentConfirmed,
      'Matricula confirmada',
      `Quedaste matriculado en ${subject.name} (grupo ${group.number}).`,
      { model: 'Enrollment', id: created._id },
    );
    // Verifica que la matricula haya quedado confirmada
    if (created.status !== EnrollmentStatus.Active) {
      throw new BadRequestException('No se pudo confirmar la matricula');
    }
    return created;
  }

  async cancel(id: string, user: AuthUser): Promise<EnrollmentDocument> {
    const enrollment = await this.findOwned(id, user);
    if (enrollment.status !== EnrollmentStatus.Active) {
      throw new BadRequestException('Solo se pueden cancelar matriculas activas');
    }
    const period = await this.periodsService.findOne(String(enrollment.period));
    if (period.status !== PeriodStatus.Open) {
      throw new BadRequestException('El periodo ya no esta abierto: no se puede cancelar');
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        enrollment.status = EnrollmentStatus.Cancelled;
        await enrollment.save({ session });
        // Libera el cupo que ocupaba en el grupo
        await this.groupModel.updateOne({ _id: enrollment.group, enrolled: { $gt: 0 } }, { $inc: { enrolled: -1 } }, { session });
      });
    } finally {
      await session.endSession();
    }

    const [student, subject] = await Promise.all([
      this.studentsService.findOne(String(enrollment.student)),
      this.subjectsService.findOne(String(enrollment.subject)),
    ]);
    await this.notificationsService.notify(
      student.user,
      NotificationType.EnrollmentCancelled,
      'Matricula cancelada',
      `Se cancelo tu matricula en ${subject.name}.`,
      { model: 'Enrollment', id: enrollment._id },
    );
    return this.findOne(id, user);
  }

  async findAll(query: EnrollmentsQueryDto, forcedStudent?: string): Promise<Paginated<Enrollment>> {
    const filter: FilterQuery<EnrollmentDocument> = {};
    const student = forcedStudent ?? query.student;
    if (student) filter.student = student;
    if (query.group) filter.group = query.group;
    if (query.period) filter.period = query.period;
    if (query.status) filter.status = query.status;

    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip(query.skip).limit(query.limit).populate(POPULATE).exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return paginate(data, total, query);
  }

  async findMine(userId: string, query: EnrollmentsQueryDto): Promise<Paginated<Enrollment>> {
    const student = await this.studentsService.findByUserId(userId);
    return this.findAll(query, student.id);
  }

  async findOne(id: string, user: AuthUser): Promise<EnrollmentDocument> {
    await this.findOwned(id, user);
    const enrollment = await this.model.findById(id).populate(POPULATE).exec();
    if (!enrollment) throw new NotFoundException('Matricula no encontrada');
    return enrollment;
  }

  /* ---------------- reglas de negocio ---------------- */

  private async resolveStudent(requested: string | undefined, user: AuthUser) {
    if (user.role === Role.Estudiante) {
      const own = await this.studentsService.findByUserId(user.id);
      if (requested && requested !== own.id) {
        throw new ForbiddenException('Un estudiante solo puede matricularse a si mismo');
      }
      return own;
    }
    if (!requested) throw new BadRequestException('Debes indicar el estudiante');
    return this.studentsService.findOne(requested);
  }

  // Devuelve la matricula cancelada previa en el mismo grupo (si existe) para reactivarla
  private async assertNotDuplicated(
    student: string,
    group: GroupDocument,
    subject: SubjectDocument,
  ): Promise<EnrollmentDocument | null> {
    const sameGroup = await this.model.findOne({ student, group: group._id }).exec();
    if (sameGroup && sameGroup.status !== EnrollmentStatus.Cancelled) {
      throw new ConflictException('El estudiante ya esta matriculado en este grupo');
    }

    const sameSubject = await this.model
      .findOne({ student, subject: subject._id, period: group.period, status: { $in: OCCUPYING } })
      .exec();
    if (sameSubject) {
      throw new ConflictException('El estudiante ya cursa esta materia en el periodo (otro grupo)');
    }

    if (await this.model.exists({ student, subject: subject._id, status: EnrollmentStatus.Passed })) {
      throw new ConflictException('El estudiante ya aprobo esta materia');
    }
    return sameGroup;
  }

  private async assertPrerequisites(student: string, subject: SubjectDocument): Promise<void> {
    const prerequisites = subject.prerequisites as unknown as { _id: Types.ObjectId; code: string }[];
    if (prerequisites.length === 0) return;

    const approved = await this.model.distinct('subject', {
      student,
      status: EnrollmentStatus.Passed,
      subject: { $in: prerequisites.map((p) => p._id) },
    });
    const approvedSet = new Set(approved.map(String));
    const missing = prerequisites.filter((p) => !approvedSet.has(String(p._id)));
    if (missing.length > 0) {
      throw new BadRequestException(`Falta aprobar los prerrequisitos: ${missing.map((m) => m.code).join(', ')}`);
    }
  }

  private async assertNoScheduleConflict(student: string, group: GroupDocument): Promise<void> {
    const current = await this.model.find({ student, period: group.period, status: EnrollmentStatus.Active }).select('group').exec();
    if (current.length === 0) return;

    const others = await this.groupModel.find({ _id: { $in: current.map((e) => e.group) } }).exec();
    for (const other of others) {
      for (const a of group.schedule) {
        for (const b of other.schedule) {
          if (slotsOverlap(a, b)) {
            throw new ConflictException(`Cruce de horario con otro grupo matriculado (${a.day} ${b.startTime}-${b.endTime})`);
          }
        }
      }
    }
  }

  private async assertCreditLimit(student: string, group: GroupDocument, subject: SubjectDocument): Promise<void> {
    const current = await this.model.find({ student, period: group.period, status: EnrollmentStatus.Active }).select('subject').exec();
    const used = await this.subjectsService.totalCredits(current.map((e) => e.subject));
    if (used + subject.credits > MAX_CREDITS_PER_PERIOD) {
      throw new BadRequestException(
        `Supera el limite de ${MAX_CREDITS_PER_PERIOD} creditos por periodo (lleva ${used}, esta materia suma ${subject.credits})`,
      );
    }
  }

  // Toma el cupo y crea la matricula en UNA transaccion: o se hace todo o no se hace nada
  private async reserveSeat(
    student: string,
    group: GroupDocument,
    subject: SubjectDocument,
    cancelled: EnrollmentDocument | null,
  ): Promise<EnrollmentDocument> {
    const session = await this.connection.startSession();
    let created!: EnrollmentDocument;
    try {
      await session.withTransaction(async () => {
        // El filtro garantiza que dos estudiantes no tomen el ultimo cupo a la vez
        const seat = await this.groupModel.findOneAndUpdate(
          { _id: group._id, active: true, $expr: { $lt: ['$enrolled', '$capacity'] } },
          { $inc: { enrolled: 1 } },
          { session },
        );
        if (!seat) throw new ConflictException('No hay cupos disponibles en el grupo');

        if (cancelled) {
          cancelled.status = EnrollmentStatus.Active;
          cancelled.finalGrade = undefined;
          created = await cancelled.save({ session });
        } else {
          const [doc] = await this.model.create(
            [{ student, group: group._id, subject: subject._id, period: group.period, status: EnrollmentStatus.Active }],
            { session },
          );
          created = doc;
        }
      });
    } finally {
      await session.endSession();
    }
    return created;
  }

  // Carga la matricula (sin populate) y verifica que el estudiante sea el dueño
  private async findOwned(id: string, user: AuthUser): Promise<EnrollmentDocument> {
    const enrollment = await this.model.findById(id).exec();
    if (!enrollment) throw new NotFoundException('Matricula no encontrada');
    if (user.role === Role.Estudiante) {
      const own = await this.studentsService.findByUserId(user.id);
      if (String(enrollment.student) !== own.id) throw new ForbiddenException('Esta matricula no es tuya');
    }
    return enrollment;
  }
}
