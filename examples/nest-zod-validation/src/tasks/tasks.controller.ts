/**
 * Nest 12 Standard Schema in three moves:
 *
 *   1. `@Body({ schema })` / `@Query({ schema })` attach a schema to the
 *      parameter metadata;
 *   2. the global `StandardSchemaValidationPipe` finds it and validates —
 *      returning the schema's OUTPUT, so defaults and coercions apply;
 *   3. `@SerializeOptions({ schema })` plus `StandardSchemaSerializerInterceptor`
 *      runs the response back through a schema on the way out.
 *
 * There is no DTO class anywhere in this example, and therefore no
 * `class-transformer`, no `emitDecoratorMetadata` dependency for validation,
 * and one definition per shape instead of two.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  SerializeOptions,
} from '@nestjs/common'
import {
  createTaskSchema,
  listTasksSchema,
  publicTaskListSchema,
  publicTaskSchema,
  updateTaskSchema,
  type CreateTaskInput,
  type ListTasksInput,
  type UpdateTaskInput,
} from './task.schemas.js'
import { TasksService } from './tasks.service.js'

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @SerializeOptions({ schema: publicTaskListSchema })
  list(@Query({ schema: listTasksSchema }) query: ListTasksInput) {
    // `query.limit` is a number here even though the wire had a string, and it
    // is 20 when the caller sent nothing — both from the schema's output type.
    return this.tasks.list(query)
  }

  @Get(':id')
  @SerializeOptions({ schema: publicTaskSchema })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    // The stored record carries `ownerEmail` and `internalNote`. The response
    // schema does not name them, so Zod strips them on the way out.
    return this.tasks.findOne(id)
  }

  @Post()
  @SerializeOptions({ schema: publicTaskSchema })
  create(@Body({ schema: createTaskSchema }) body: CreateTaskInput) {
    return this.tasks.create(body)
  }

  @Patch(':id')
  @SerializeOptions({ schema: publicTaskSchema })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateTaskSchema }) body: UpdateTaskInput,
  ) {
    return this.tasks.update(id, body)
  }

  /**
   * The same handler without `@SerializeOptions` — proof that the stripping is
   * the serializer's doing and not the service's. Do not ship a route like
   * this; it exists so the README can show both bodies side by side.
   */
  @Get(':id/raw')
  raw(@Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.findOne(id)
  }
}
