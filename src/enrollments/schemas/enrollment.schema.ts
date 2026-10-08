import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Group } from '../../groups/schemas/group.schema';
import { Period } from '../../periods/schemas/period.schema';
import { Student } from '../../students/schemas/student.schema';
import { Subject } from '../../subjects/schemas/subject.schema';

export type EnrollmentDocument = HydratedDocument<Enrollment>;

export enum EnrollmentStatus {
  Active = 'activa',
  Cancelled = 'cancelada',
  Passed = 'aprobada',
  Failed = 'reprobada',
}

@Schema({ timestamps: true })
export class Enrollment {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Student.name, required: true })
  student!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Group.name, required: true, index: true })
  group!: Types.ObjectId;

  // Copiados del grupo al matricular: permiten validar prerrequisitos y cruces sin joins
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Subject.name, required: true })
  subject!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Period.name, required: true, index: true })
  period!: Types.ObjectId;

  @Prop({ required: true, enum: EnrollmentStatus, default: EnrollmentStatus.Active })
  status!: EnrollmentStatus;

  // Nota final (0.0 a 5.0). Se calcula al finalizar el grupo a partir de las notas
  @Prop({ min: 0, max: 5 })
  finalGrade?: number;
}

export const EnrollmentSchema = SchemaFactory.createForClass(Enrollment);
EnrollmentSchema.index({ student: 1, group: 1 }, { unique: true });
EnrollmentSchema.index({ student: 1, subject: 1, status: 1 });
EnrollmentSchema.index({ student: 1, period: 1, status: 1 });
