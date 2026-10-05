import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { toBoolean } from '../../common/dto/query-helpers';

export class CreateNotificationDto {
  @ApiProperty({ description: 'ID del usuario que recibe el aviso' })
  @IsMongoId()
  user!: string;

  @ApiProperty({ example: 'Cambio de salon' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiProperty({ example: 'Tu clase del lunes pasa al salon B-204.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message!: string;
}

export class NotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'true = leidas, false = sin leer' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  read?: boolean;
}
