/**
 * `PartialType` from @nestjs/mapped-types rebuilds CreateTaskDto with every
 * property optional, keeping the validation decorators. Writing the class out
 * by hand is how the two drift apart.
 */
import { PartialType } from '@nestjs/mapped-types'
import { CreateTaskDto } from './create-task.dto.js'

export class UpdateTaskDto extends PartialType(CreateTaskDto) {}
