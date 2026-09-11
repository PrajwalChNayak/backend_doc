/**
 * Every handler here is two lines: take validated input, call the service,
 * return a plain object. The status code, the JSON, the envelope and the error
 * shape are all somebody else's job.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { ApiKeyGuard } from '../common/api-key.guard.js'
import { EnvelopeInterceptor } from '../common/envelope.interceptor.js'
import { Public } from '../common/public.decorator.js'
import { CreateTaskDto } from './dto/create-task.dto.js'
import { ListTasksDto } from './dto/list-tasks.dto.js'
import { UpdateTaskDto } from './dto/update-task.dto.js'
import { TasksService } from './tasks.service.js'

@Controller('tasks')
@UseGuards(ApiKeyGuard) // every route in here needs the key…
@UseInterceptors(EnvelopeInterceptor)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @Public() // …except the reads, which say so out loud.
  list(@Query() query: ListTasksDto) {
    return this.tasks.list(query)
  }

  @Get(':id')
  @Public()
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    // ParseUUIDPipe turns a malformed id into a 400 before the service runs, so
    // "not a uuid" and "no such task" are different answers.
    return this.tasks.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateTaskDto) {
    return this.tasks.create(dto)
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(id, dto)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): void {
    this.tasks.remove(id)
  }
}
