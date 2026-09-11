/**
 * The service owns the rules. "A task that does not exist is a 404" is a rule,
 * so it lives here and is expressed by throwing — the controller never builds a
 * response, and the repository never knows what HTTP is.
 */
import { Injectable, NotFoundException } from '@nestjs/common'
import { TasksRepository } from './tasks.repository.js'
import type { Task } from './task.entity.js'
import type { CreateTaskDto } from './dto/create-task.dto.js'
import type { UpdateTaskDto } from './dto/update-task.dto.js'
import type { ListTasksDto } from './dto/list-tasks.dto.js'

@Injectable()
export class TasksService {
  constructor(private readonly repository: TasksRepository) {}

  create(dto: CreateTaskDto): Task {
    return this.repository.insert(dto)
  }

  list(query: ListTasksDto): { data: Task[]; meta: { total: number; limit: number; offset: number } } {
    const { rows, total } = this.repository.list({
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    })
    return { data: rows, meta: { total, limit: query.limit, offset: query.offset } }
  }

  findOne(id: string): Task {
    const task = this.repository.findById(id)
    if (!task) throw new NotFoundException(`No task with id ${id}`)
    return task
  }

  update(id: string, dto: UpdateTaskDto): Task {
    const updated = this.repository.update(id, dto)
    if (!updated) throw new NotFoundException(`No task with id ${id}`)
    return updated
  }

  remove(id: string): void {
    if (!this.repository.remove(id)) throw new NotFoundException(`No task with id ${id}`)
  }
}
