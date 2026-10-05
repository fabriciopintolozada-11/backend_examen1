import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Classroom, ClassroomDocument } from '../classrooms/schemas/classroom.schema';
import { Enrollment, EnrollmentDocument, EnrollmentStatus } from '../enrollments/schemas/enrollment.schema';
import { Faculty, FacultyDocument } from '../faculties/schemas/faculty.schema';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { PeriodsService } from '../periods/periods.service';
import { Program, ProgramDocument } from '../programs/schemas/program.schema';
import { Student, StudentDocument } from '../students/schemas/student.schema';
import { Subject, SubjectDocument } from '../subjects/schemas/subject.schema';
import { Teacher, TeacherDocument } from '../teachers/schemas/teacher.schema';
import { Role } from '../common/enums/role.enum';
import { User, UserDocument } from '../users/schemas/user.schema';
import { ReportQueryDto } from './dto/reports.dto';

const CLOSED = [EnrollmentStatus.Passed, EnrollmentStatus.Failed];
const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
const round = (expr: unknown, decimals: number) => ({ $round: [expr, decimals] });

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Enrollment.name) private readonly enrollmentModel: Model<EnrollmentDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(Student.name) private readonly studentModel: Model<StudentDocument>,
    @InjectModel(Teacher.name) private readonly teacherModel: Model<TeacherDocument>,
    @InjectModel(Program.name) private readonly programModel: Model<ProgramDocument>,
    @InjectModel(Subject.name) private readonly subjectModel: Model<SubjectDocument>,
    @InjectModel(Faculty.name) private readonly facultyModel: Model<FacultyDocument>,
    @InjectModel(Classroom.name) private readonly classroomModel: Model<ClassroomDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly periodsService: PeriodsService,
  ) {}

  // Resumen general: conteos de todo el sistema y fotografia del periodo abierto
  async dashboard() {
    const [users, students, teachers, programs, subjects, faculties, classrooms, groups] = await Promise.all([
      this.userModel.aggregate([{ $group: { _id: '$role', total: { $sum: 1 } } }]),
      this.studentModel.countDocuments({ active: true }),
      this.teacherModel.countDocuments({ active: true }),
      this.programModel.countDocuments({ active: true }),
      this.subjectModel.countDocuments({ active: true }),
      this.facultyModel.countDocuments(),
      this.classroomModel.countDocuments({ active: true }),
      this.groupModel.countDocuments({ active: true }),
    ]);

    let period: unknown = null;
    try {
      const current = await this.periodsService.findCurrent();
      const seats = await this.groupModel.aggregate<{ capacity: number; enrolled: number; groups: number }>([
        { $match: { period: current._id, active: true } },
        { $group: { _id: null, capacity: { $sum: '$capacity' }, enrolled: { $sum: '$enrolled' }, groups: { $sum: 1 } } },
      ]);
      const byStatus = await this.enrollmentModel.aggregate<{ _id: string; total: number }>([
        { $match: { period: current._id } },
        { $group: { _id: '$status', total: { $sum: 1 } } },
      ]);
      const s = seats[0] ?? { capacity: 0, enrolled: 0, groups: 0 };
      period = {
        id: current.id,
        code: current.code,
        groups: s.groups,
        capacity: s.capacity,
        enrolled: s.enrolled,
        occupancyPercent: s.capacity > 0 ? Math.round((s.enrolled / s.capacity) * 1000) / 10 : 0,
        enrollmentsByStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.total])),
      };
    } catch (error) {
      // Sin periodo abierto: el resto del tablero sigue siendo valido. Cualquier otro fallo se propaga
      if (!(error instanceof NotFoundException)) throw error;
    }

    return {
      users: Object.fromEntries(
        [Role.Admin, Role.Docente, Role.Estudiante].map((r) => [r, users.find((u) => u._id === r)?.total ?? 0]),
      ),
      active: { students, teachers, programs, subjects, classrooms, groups },
      faculties,
      currentPeriod: period,
    };
  }

  // Matriculas y estudiantes distintos por programa
  async enrollmentsByProgram(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const rows = await this.enrollmentModel.aggregate([
      { $match: { period: period._id, status: { $ne: EnrollmentStatus.Cancelled } } },
      { $lookup: { from: this.studentModel.collection.name, localField: 'student', foreignField: '_id', as: 'st' } },
      { $unwind: '$st' },
      { $group: { _id: '$st.program', enrollments: { $sum: 1 }, students: { $addToSet: '$student' } } },
      { $lookup: { from: this.programModel.collection.name, localField: '_id', foreignField: '_id', as: 'pr' } },
      { $unwind: '$pr' },
      {
        $project: {
          _id: 0,
          program: { id: '$_id', code: '$pr.code', name: '$pr.name' },
          enrollments: 1,
          students: { $size: '$students' },
        },
      },
      { $sort: { enrollments: -1 } },
    ]);
    return { period: { id: period.id, code: period.code }, rows };
  }

  // Ocupacion de los grupos (mas llenos primero)
  async groupOccupancy(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const rows = await this.groupModel.aggregate([
      { $match: { period: period._id, active: true } },
      { $lookup: { from: this.subjectModel.collection.name, localField: 'subject', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      {
        $project: {
          _id: 0,
          group: '$_id',
          subject: { code: '$sub.code', name: '$sub.name' },
          number: 1,
          capacity: 1,
          enrolled: 1,
          availableSeats: { $max: [{ $subtract: ['$capacity', '$enrolled'] }, 0] },
          occupancyPercent: round({ $multiply: [{ $divide: ['$enrolled', '$capacity'] }, 100] }, 1),
        },
      },
      { $sort: { occupancyPercent: -1, 'subject.code': 1 } },
      { $limit: query.limit },
    ]);
    return { period: { id: period.id, code: period.code }, rows };
  }

  // Aprobacion y promedio por materia (de las matriculas ya finalizadas)
  async subjectPerformance(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const pipeline: PipelineStage[] = [
      { $match: { period: period._id, status: { $in: CLOSED } } },
      { $lookup: { from: this.subjectModel.collection.name, localField: 'subject', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
    ];
    if (query.program) pipeline.push({ $match: { 'sub.program': oid(query.program) } });
    pipeline.push(
      {
        $group: {
          _id: '$subject',
          code: { $first: '$sub.code' },
          name: { $first: '$sub.name' },
          total: { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ['$status', EnrollmentStatus.Passed] }, 1, 0] } },
          average: { $avg: '$finalGrade' },
        },
      },
      {
        $project: {
          _id: 0,
          subject: { id: '$_id', code: '$code', name: '$name' },
          finalized: '$total',
          passed: 1,
          failed: { $subtract: ['$total', '$passed'] },
          passRate: round({ $multiply: [{ $divide: ['$passed', '$total'] }, 100] }, 1),
          averageGrade: round('$average', 2),
        },
      },
      { $sort: { passRate: 1, 'subject.code': 1 } },
      { $limit: query.limit },
    );
    return { period: { id: period.id, code: period.code }, rows: await this.enrollmentModel.aggregate(pipeline) };
  }

  // Mejores promedios (ponderados por creditos). Sin 'period' en la consulta se usa el periodo abierto
  async topStudents(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const rows = await this.studentPerformance(period._id, query.program, [{ $sort: { gpa: -1, credits: -1 } }, { $limit: query.limit }]);
    return { period: { id: period.id, code: period.code }, rows };
  }

  // Estudiantes con materias reprobadas en el periodo
  async atRiskStudents(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const rows = await this.studentPerformance(period._id, query.program, [
      { $match: { failed: { $gte: query.minFailed } } },
      { $sort: { failed: -1, gpa: 1 } },
      { $limit: query.limit },
    ]);
    return { period: { id: period.id, code: period.code }, minFailed: query.minFailed, rows };
  }

  // Carga docente: grupos, estudiantes y creditos por docente
  async teacherLoad(query: ReportQueryDto) {
    const period = await this.resolvePeriod(query.period);
    const rows = await this.groupModel.aggregate([
      { $match: { period: period._id, active: true } },
      { $lookup: { from: this.subjectModel.collection.name, localField: 'subject', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      { $group: { _id: '$teacher', groups: { $sum: 1 }, students: { $sum: '$enrolled' }, credits: { $sum: '$sub.credits' } } },
      { $lookup: { from: this.teacherModel.collection.name, localField: '_id', foreignField: '_id', as: 'tc' } },
      { $unwind: '$tc' },
      { $lookup: { from: this.userModel.collection.name, localField: 'tc.user', foreignField: '_id', as: 'us' } },
      { $unwind: '$us' },
      { $project: { _id: 0, teacher: { id: '$_id', code: '$tc.code', name: '$us.name' }, groups: 1, students: 1, credits: 1 } },
      { $sort: { students: -1, 'teacher.code': 1 } },
      { $limit: query.limit },
    ]);
    return { period: { id: period.id, code: period.code }, rows };
  }

  // Programas, docentes y estudiantes por facultad
  async facultySummary() {
    const [programs, teachers, students, faculties] = await Promise.all([
      this.programModel.aggregate<{ _id: Types.ObjectId; total: number }>([{ $group: { _id: '$faculty', total: { $sum: 1 } } }]),
      this.teacherModel.aggregate<{ _id: Types.ObjectId; total: number }>([{ $group: { _id: '$faculty', total: { $sum: 1 } } }]),
      this.studentModel.aggregate<{ _id: Types.ObjectId; total: number }>([
        { $lookup: { from: this.programModel.collection.name, localField: 'program', foreignField: '_id', as: 'pr' } },
        { $unwind: '$pr' },
        { $group: { _id: '$pr.faculty', total: { $sum: 1 } } },
      ]),
      this.facultyModel.find().sort({ name: 1 }).lean(),
    ]);
    const count = (list: { _id: Types.ObjectId; total: number }[], id: Types.ObjectId) =>
      list.find((x) => String(x._id) === String(id))?.total ?? 0;

    return {
      rows: faculties.map((f) => ({
        faculty: { id: f._id, code: f.code, name: f.name },
        programs: count(programs, f._id),
        teachers: count(teachers, f._id),
        students: count(students, f._id),
      })),
    };
  }

  /* ---------------- utilidades ---------------- */

  // Promedio ponderado por creditos y materias aprobadas/reprobadas de cada estudiante en un periodo.
  // 'tail' agrega las etapas finales (orden, filtro, limite) y luego se agregan los datos del estudiante
  private async studentPerformance(period: Types.ObjectId, program: string | undefined, tail: PipelineStage[]) {
    const pipeline: PipelineStage[] = [
      { $match: { period, status: { $in: CLOSED }, finalGrade: { $exists: true } } },
      { $lookup: { from: this.subjectModel.collection.name, localField: 'subject', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      { $lookup: { from: this.studentModel.collection.name, localField: 'student', foreignField: '_id', as: 'st' } },
      { $unwind: '$st' },
    ];
    if (program) pipeline.push({ $match: { 'st.program': oid(program) } });
    pipeline.push(
      {
        $group: {
          _id: '$student',
          code: { $first: '$st.code' },
          user: { $first: '$st.user' },
          weighted: { $sum: { $multiply: ['$finalGrade', '$sub.credits'] } },
          credits: { $sum: '$sub.credits' },
          passed: { $sum: { $cond: [{ $eq: ['$status', EnrollmentStatus.Passed] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', EnrollmentStatus.Failed] }, 1, 0] } },
        },
      },
      { $addFields: { gpa: round({ $divide: ['$weighted', '$credits'] }, 2) } },
      ...tail,
      { $lookup: { from: this.userModel.collection.name, localField: 'user', foreignField: '_id', as: 'us' } },
      { $unwind: '$us' },
      { $project: { _id: 0, student: { id: '$_id', code: '$code', name: '$us.name' }, gpa: 1, credits: 1, passed: 1, failed: 1 } },
    );
    return this.enrollmentModel.aggregate(pipeline);
  }

  private resolvePeriod(periodId?: string) {
    return periodId ? this.periodsService.findOne(periodId) : this.periodsService.findCurrent();
  }
}
