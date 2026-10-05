import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { Enrollment, EnrollmentDocument, EnrollmentStatus } from '../enrollments/schemas/enrollment.schema';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { CreatePeriodDto, PeriodsQueryDto, UpdatePeriodDto } from './dto/period.dto';
import { Period, PeriodDocument, PeriodStatus } from './schemas/period.schema';

export interface CloseCheck {
  period: { id: string; code: string; status: PeriodStatus };
  canClose: boolean;
  pendingEnrollments: number;
  groups: { group: Types.ObjectId; subject: { code: string; name: string }; number: number; pending: number }[];
}

@Injectable()
export class PeriodsService {
  constructor(
    @InjectModel(Period.name) private readonly model: Model<PeriodDocument>,
    // Para el cierre del periodo se leen matriculas y grupos directamente (evita un ciclo de modulos)
    @InjectModel(Enrollment.name) private readonly enrollmentModel: Model<EnrollmentDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  create(dto: CreatePeriodDto): Promise<PeriodDocument> {
    this.assertDates(new Date(dto.startDate), new Date(dto.endDate));
    return this.model.create(dto);
  }

  async findAll(query: PeriodsQueryDto): Promise<Paginated<Period>> {
    const filter: FilterQuery<PeriodDocument> = query.status ? { status: query.status } : {};
    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ startDate: -1 }).skip(query.skip).limit(query.limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return paginate(data, total, query);
  }

  // El periodo abierto (solo puede haber uno). Es el que usan las matriculas
  async findCurrent(): Promise<PeriodDocument> {
    const period = await this.model.findOne({ status: PeriodStatus.Open }).exec();
    if (!period) throw new NotFoundException('No hay un periodo abierto');
    return period;
  }

  async findOne(id: string): Promise<PeriodDocument> {
    const period = await this.model.findById(id).exec();
    if (!period) throw new NotFoundException('Periodo no encontrado');
    return period;
  }

  async update(id: string, dto: UpdatePeriodDto): Promise<PeriodDocument> {
    const period = await this.findOne(id);
    // El cierre es irreversible: un periodo cerrado ya no cambia (ni codigo, ni fechas, ni estado)
    if (period.status === PeriodStatus.Closed) {
      throw new BadRequestException('Un periodo cerrado no se puede modificar');
    }

    const start = dto.startDate ? new Date(dto.startDate) : period.startDate;
    const end = dto.endDate ? new Date(dto.endDate) : period.endDate;
    this.assertDates(start, end);

    // Ciclo de vida: planificado -> abierto -> cerrado. El cierre solo se hace con POST /periods/:id/close
    if (dto.status && dto.status !== period.status) {
      if (dto.status === PeriodStatus.Closed) {
        throw new BadRequestException('Para cerrar un periodo usa POST /periods/:id/close');
      }
    }

    // Solo puede haber un periodo abierto a la vez
    if (dto.status === PeriodStatus.Open && period.status !== PeriodStatus.Open) {
      const open = await this.model.exists({ status: PeriodStatus.Open, _id: { $ne: id } });
      if (open) throw new ConflictException('Ya existe otro periodo abierto');
    }

    period.set({ ...dto, startDate: start, endDate: end });
    return period.save();
  }

  // Revision previa al cierre: que matriculas siguen activas (sin nota final) y en que grupos
  async closeCheck(id: string): Promise<CloseCheck> {
    const period = await this.findOne(id);
    const groups = await this.enrollmentModel.aggregate<CloseCheck['groups'][number]>([
      { $match: { period: period._id, status: EnrollmentStatus.Active } },
      { $group: { _id: '$group', pending: { $sum: 1 } } },
      { $lookup: { from: this.groupModel.collection.name, localField: '_id', foreignField: '_id', as: 'g' } },
      { $unwind: '$g' },
      { $lookup: { from: 'subjects', localField: 'g.subject', foreignField: '_id', as: 's' } },
      { $unwind: '$s' },
      { $project: { _id: 0, group: '$_id', subject: { code: '$s.code', name: '$s.name' }, number: '$g.number', pending: 1 } },
      { $sort: { 'subject.code': 1, number: 1 } },
    ]);
    const pendingEnrollments = groups.reduce((sum, g) => sum + g.pending, 0);
    return {
      period: { id: period.id, code: period.code, status: period.status },
      canClose: period.status === PeriodStatus.Open && pendingEnrollments === 0,
      pendingEnrollments,
      groups,
    };
  }

  // Cierra el periodo. Si quedan matriculas activas sin finalizar, exige cancelPending=true para cancelarlas
  async close(id: string, cancelPending: boolean): Promise<Record<string, unknown>> {
    const period = await this.findOne(id);
    if (period.status === PeriodStatus.Closed) throw new ConflictException('El periodo ya esta cerrado');
    if (period.status !== PeriodStatus.Open) throw new BadRequestException('Solo se puede cerrar un periodo abierto');

    const check = await this.closeCheck(id);
    if (check.pendingEnrollments > 0 && !cancelPending) {
      throw new ConflictException(
        `Hay ${check.pendingEnrollments} matriculas activas sin finalizar en ${check.groups.length} grupos. ` +
          'Finalizalas con POST /groups/:id/finalize o cierra con ?cancelPending=true para cancelarlas',
      );
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (check.pendingEnrollments > 0) {
          await this.enrollmentModel.updateMany(
            { period: period._id, status: EnrollmentStatus.Active },
            { $set: { status: EnrollmentStatus.Cancelled } },
            { session },
          );
          // Los grupos quedan con el conteo real de matriculas vigentes
          for (const g of check.groups) {
            const enrolled = await this.enrollmentModel.countDocuments({ group: g.group, status: { $ne: EnrollmentStatus.Cancelled } }, { session });
            await this.groupModel.updateOne({ _id: g.group }, { $set: { enrolled } }, { session });
          }
        }
        period.status = PeriodStatus.Closed;
        await period.save({ session });
      });
    } finally {
      await session.endSession();
    }

    const byStatus = await this.enrollmentModel.aggregate<{ _id: string; total: number }>([
      { $match: { period: period._id } },
      { $group: { _id: '$status', total: { $sum: 1 } } },
    ]);
    return {
      period: { id: period.id, code: period.code, status: period.status },
      closed: true,
      cancelledPending: check.pendingEnrollments,
      enrollmentsByStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.total])),
    };
  }

  private assertDates(start: Date, end: Date): void {
    if (end <= start) {
      throw new BadRequestException('La fecha de fin debe ser posterior a la de inicio');
    }
  }
}
