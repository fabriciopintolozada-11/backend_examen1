import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Paginated, paginate } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { CreateNotificationDto, NotificationsQueryDto } from './dto/notification.dto';
import { Notification, NotificationDocument, NotificationType } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private readonly model: Model<NotificationDocument>,
    private readonly usersService: UsersService,
  ) {}

  // Aviso manual del administrador a un usuario
  async create(dto: CreateNotificationDto): Promise<NotificationDocument> {
    const user = await this.usersService.findById(dto.user);
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.model.create({ ...dto, type: NotificationType.Notice });
  }

  // Aviso automatico del sistema (matricula, nota final, grupo asignado).
  // Nunca debe romper la operacion que lo origina: si falla, solo se deja constancia en el log
  async notify(
    user: unknown,
    type: NotificationType,
    title: string,
    message: string,
    related?: { model: string; id: unknown },
  ): Promise<void> {
    try {
      await this.model.create({
        user: this.idOf(user),
        type,
        title,
        message,
        ...(related ? { relatedModel: related.model, relatedId: this.idOf(related.id) } : {}),
      });
    } catch (error) {
      this.logger.warn(`No se pudo crear la notificacion '${type}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Acepta un ID o un documento ya poblado ({ _id, ... })
  private idOf(value: unknown): unknown {
    return value && typeof value === 'object' && '_id' in value ? (value as { _id: unknown })._id : value;
  }

  async findMine(userId: string, query: NotificationsQueryDto): Promise<Paginated<Notification> & { unread: number }> {
    const filter: FilterQuery<NotificationDocument> = { user: userId };
    if (query.read !== undefined) filter.read = query.read;

    const [data, total, unread] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip(query.skip).limit(query.limit).exec(),
      this.model.countDocuments(filter).exec(),
      this.model.countDocuments({ user: userId, read: false }).exec(),
    ]);
    return { ...paginate(data, total, query), unread };
  }

  async markRead(id: string, userId: string): Promise<NotificationDocument> {
    const notification = await this.model.findById(id).exec();
    if (!notification) throw new NotFoundException('Notificacion no encontrada');
    if (String(notification.user) !== userId) throw new ForbiddenException('Esta notificacion no es tuya');

    if (!notification.read) {
      notification.read = true;
      notification.readAt = new Date();
      await notification.save();
    }
    return notification;
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.model.updateMany({ user: userId, read: false }, { $set: { read: true, readAt: new Date() } }).exec();
    return { updated: result.modifiedCount };
  }
}
