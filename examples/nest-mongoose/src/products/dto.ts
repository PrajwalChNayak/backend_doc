import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator'

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  name!: string

  @IsString()
  @Matches(/^[A-Z0-9-]{3,32}$/, { message: 'sku must be 3-32 chars of A-Z, 0-9 or -' })
  sku!: string

  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents!: number

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  tags?: string[]
}
