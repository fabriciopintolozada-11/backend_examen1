import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

export type NotificationDocument = HydratedDocument<Notification>;

export enum NotificationType {
  EnrollmentConfirmed = 'matricula_confirmada',
  EnrollmentCancelled = 'matricula_cancelada',
  FinalGrade = 'nota_final',
  GroupAssigned = 'grupo_asignado',
  Notice = 'aviso',
}

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: User.name, required: true, index: true })
  user!: Types.ObjectId;

  @Prop({ required: true, enum: NotificationType, default: NotificationType.Notice })
  type!: NotificationType;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ required: true, trim: true })
  message!: string;

  @Prop({ default: false })
  read!: boolean;

  @Prop()
  readAt?: Date;

  // Documento al que se refiere el aviso (matricula, grupo...). Opcional
  @Prop()
  relatedModel?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, refPath: 'relatedModel' })
  relatedId?: Types.ObjectId;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ user: 1, read: 1, createdAt: -1 });
