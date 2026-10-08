import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Enrollment } from '../../enrollments/schemas/enrollment.schema';
import { Evaluation } from '../../evaluations/schemas/evaluation.schema';

export type GradeDocument = HydratedDocument<Grade>;

// Nota de un estudiante (por su matricula) en una evaluacion. Escala colombiana 0.0 a 5.0
@Schema({ timestamps: true })
export class Grade {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Enrollment.name, required: true, index: true })
  enrollment!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Evaluation.name, required: true, index: true })
  evaluation!: Types.ObjectId;

  @Prop({ required: true, min: 0, max: 5 })
  value!: number;
}

export const GradeSchema = SchemaFactory.createForClass(Grade);
GradeSchema.index({ enrollment: 1, evaluation: 1 }, { unique: true });
