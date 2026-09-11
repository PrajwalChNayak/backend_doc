/**
 * The DTO is the contract. `whitelist: true` on the global pipe strips every
 * property that has no decorator here, and `forbidNonWhitelisted: true` turns
 * that strip into a 400 — which is the difference between silently ignoring
 * `{"status":"done","isAdmin":true}` and telling the caller no.
 */
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import type { TaskStatus } from '../task.entity.js'

export class CreateTaskDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  @MaxLength(120)
  title!: string

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string

  @IsOptional()
  @IsIn(['todo', 'doing', 'done'])
  status?: TaskStatus
}
