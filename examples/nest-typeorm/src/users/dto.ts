import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  @MaxLength(320)
  email!: string

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string
}

export class NewPostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string

  @IsOptional()
  @IsString()
  body?: string
}

export class CreateUserWithPostsDto extends CreateUserDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => NewPostDto)
  posts!: NewPostDto[]
}
