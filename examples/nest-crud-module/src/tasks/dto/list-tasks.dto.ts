/**
 * Query strings are always strings. `transform: true` plus `@Type(() => Number)`
 * converts `?limit=5` into the number 5 before `@Min`/`@Max` see it.
 *
 * Note what does NOT happen: nothing is written back to `req.query`, which is a
 * getter in Express 5 and would throw.
 */
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import type { TaskStatus } from '../task.entity.js'

export class ListTasksDto {
  @IsOptional()
  @IsIn(['todo', 'doing', 'done'])
  status?: TaskStatus

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0
}
