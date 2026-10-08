import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, PopulateOptions } from 'mongoose';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { Enrollment, EnrollmentDocument, EnrollmentStatus } from '../enrollments/schemas/enrollment.schema';
import { Evaluation, EvaluationDocument } from '../evaluations/schemas/evaluation.schema';
import { GroupsService } from '../groups/groups.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/schemas/notification.schema';
import { StudentsService } from '../students/students.service';
import { SubjectsService } from '../subjects/subjects.service';
import { BulkGradesDto, GradesQueryDto, UpsertGradeDto } from './dto/grade.dto';
import { Grade, GradeDocument } from './schemas/grade.schema';

// Nota minima para aprobar (escala 0.0 - 5.0)
export const PASSING_GRADE = 3.0;

const POPULATE: PopulateOptions[] = [
  { path: 'evaluation', select: 'name weight group' },
  { path: 'enrollment', select: 'status finalGrade subject', populate: { path: 'subject', select: 'code name' } },
];

@Injectable()
export class GradesService {
  constructor(
    @InjectModel(Grade.name) private readonly model: Model<GradeDocument>,
    @InjectModel(Enrollment.name) private readonly enrollmentModel: Model<EnrollmentDocument>,
    @InjectModel(Evaluation.name) private readonly evaluationModel: Model<EvaluationDocument>,
    private readonly groupsService: GroupsService,
    private readonly studentsService: StudentsService,
    private readonly subjectsService: SubjectsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Registra o corrige la nota de un estudiante en una evaluacion
  async upsert(dto: UpsertGradeDto, user: AuthUser): Promise<GradeDocument> {
    const enrollment = await this.findEnrollment(dto.enrollment);
    const evaluation = await this.evaluationModel.findById(dto.evaluation).exec();
    if (!evaluation) throw new NotFoundException('Evaluacion no encontrada');

    if (String(enrollment.group) !== String(evaluation.group)) {
      throw new BadRequestException('La evaluacion no pertenece al grupo de la matricula');
    }
    await this.groupsService.assertCanManage(String(enrollment.group), user);
    if (enrollment.status !== EnrollmentStatus.Active) {
      throw new BadRequestException('Solo se pueden calificar matriculas activas');
    }

    return this.model.findOneAndUpdate(
      { enrollment: enrollment._id, evaluation: evaluation._id },
      { $set: { value: dto.value } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ) as unknown as Promise<GradeDocument>;
  }

  // Guarda varias notas de una vez (planilla completa). Una nota con error no detiene las demas
  async bulkUpsert(dto: BulkGradesDto, user: AuthUser) {
    const failed: { index: number; enrollment: string; evaluation: string; reason: string }[] = [];
    let saved = 0;
    for (const [index, item] of dto.items.entries()) {
      try {
        await this.upsert(item, user);
        saved++;
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const res = error.getResponse();
        const message = typeof res === 'string' ? res : (res as { message?: string | string[] }).message;
        failed.push({
          index,
          enrollment: item.enrollment,
          evaluation: item.evaluation,
          reason: Array.isArray(message) ? message.join('; ') : (message ?? error.message),
        });
      }
    }
    return { total: dto.items.length, saved, failed };
  }

  async findAll(query: GradesQueryDto, user: AuthUser): Promise<Paginated<Grade>> {
    if (!query.enrollment && !query.evaluation) {
      throw new BadRequestException('Indica enrollment o evaluation para consultar notas');
    }
    // Verifica que el docente consulte solo grupos a su cargo
    if (query.enrollment) {
      const enrollment = await this.findEnrollment(query.enrollment);
      await this.groupsService.assertCanManage(String(enrollment.group), user);
    } else if (query.evaluation) {
      const evaluation = await this.evaluationModel.findById(query.evaluation).exec();
      if (!evaluation) throw new NotFoundException('Evaluacion no encontrada');
      await this.groupsService.assertCanManage(String(evaluation.group), user);
    }

    const filter: FilterQuery<GradeDocument> = {};
    if (query.enrollment) filter.enrollment = query.enrollment;
    if (query.evaluation) filter.evaluation = query.evaluation;
    return this.list(filter, query);
  }

  // Notas del estudiante autenticado
  async findMine(userId: string, query: GradesQueryDto): Promise<Paginated<Grade>> {
    const student = await this.studentsService.findByUserId(userId);
    const enrollmentFilter: FilterQuery<EnrollmentDocument> = { student: student.id, status: { $ne: EnrollmentStatus.Cancelled } };
    if (query.enrollment) enrollmentFilter._id = query.enrollment;
    const ids = await this.enrollmentModel.find(enrollmentFilter).distinct('_id');
    return this.list({ enrollment: { $in: ids } }, query);
  }

  // Calcula la nota final ponderada y deja la matricula como aprobada o reprobada
  async finalize(enrollmentId: string, user: AuthUser): Promise<{ id: string; finalGrade: number; status: EnrollmentStatus }> {
    const enrollment = await this.findEnrollment(enrollmentId);
    await this.groupsService.assertCanManage(String(enrollment.group), user);
    if (enrollment.status !== EnrollmentStatus.Active) {
      throw new BadRequestException('Solo se pueden finalizar matriculas activas');
    }

    const evaluations = await this.evaluationModel.find({ group: enrollment.group }).exec();
    const totalWeight = evaluations.reduce((sum, e) => sum + e.weight, 0);
    if (Math.round(totalWeight * 100) !== 10000) {
      throw new BadRequestException(`Los porcentajes del grupo no suman 100 (suman ${totalWeight})`);
    }

    const grades = await this.model.find({ enrollment: enrollment._id }).exec();
    const byEvaluation = new Map(grades.map((g) => [String(g.evaluation), g.value]));
    const missing = evaluations.filter((e) => !byEvaluation.has(String(e._id)));
    if (missing.length > 0) {
      throw new BadRequestException(`Faltan notas en: ${missing.map((m) => m.name).join(', ')}`);
    }

    const finalGrade = Math.round(evaluations.reduce((sum, e) => sum + (byEvaluation.get(String(e._id)) as number) * (e.weight / 100), 0) * 100) / 100;
    enrollment.finalGrade = finalGrade;
    enrollment.status = finalGrade >= PASSING_GRADE ? EnrollmentStatus.Passed : EnrollmentStatus.Failed;
    await enrollment.save();

    const [student, subject] = await Promise.all([
      this.studentsService.findOne(String(enrollment.student)),
      this.subjectsService.findOne(String(enrollment.subject)),
    ]);
    await this.notificationsService.notify(
      student.user,
      NotificationType.FinalGrade,
      'Nota final publicada',
      `Tu nota final en ${subject.name} es ${finalGrade.toFixed(2)} (${enrollment.status}).`,
      { model: 'Enrollment', id: enrollment._id },
    );
    return { id: enrollment.id, finalGrade, status: enrollment.status };
  }

  private async list(filter: FilterQuery<GradeDocument>, query: GradesQueryDto): Promise<Paginated<Grade>> {
    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: 1 }).skip(query.skip).limit(query.limit).populate(POPULATE).exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return paginate(data, total, query);
  }

  private async findEnrollment(id: string): Promise<EnrollmentDocument> {
    const enrollment = await this.enrollmentModel.findById(id).exec();
    if (!enrollment) throw new NotFoundException('Matricula no encontrada');
    return enrollment;
  }
}
