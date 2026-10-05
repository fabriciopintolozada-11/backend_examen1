import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class UpsertGradeDto {
  @ApiProperty({ description: 'ID de la matricula del estudiante' })
  @IsMongoId()
  enrollment!: string;

  @ApiProperty({ description: 'ID de la evaluacion' })
  @IsMongoId()
  evaluation!: string;

  @ApiProperty({ minimum: 0, maximum: 5, example: 4.2, description: 'Nota de 0.0 a 5.0 (maximo 2 decimales)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(5)
  value!: number;
}

export class BulkGradesDto {
  @ApiProperty({ type: [UpsertGradeDto], description: 'Hasta 200 notas. Cada una se guarda por separado' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpsertGradeDto)
  items!: UpsertGradeDto[];
}

export class GradesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Notas de una matricula' })
  @IsOptional()
  @IsMongoId()
  enrollment?: string;

  @ApiPropertyOptional({ description: 'Notas de una evaluacion' })
  @IsOptional()
  @IsMongoId()
  evaluation?: string;
}
