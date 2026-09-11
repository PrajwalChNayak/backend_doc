import { Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { CreateTaskInput, ListTasksInput, UpdateTaskInput } from './task.schemas.js'

/** What is stored — deliberately wider than what is returned. */
export interface StoredTask {
  id: string
  title: string
  notes: string
  status: 'todo' | 'doing' | 'done'
  createdAt: string
  ownerEmail: string | null
  internalNote: string
}

@Injectable()
export class TasksService {
  private readonly rows = new Map<string, StoredTask>()

  constructor() {
    this.create({ title: 'Learn Standard Schema', status: 'doing' })
    this.create({ title: 'Delete the DTO classes', status: 'todo' })
  }

  create(input: CreateTaskInput): StoredTask {
    const task: StoredTask = {
      id: randomUUID(),
      title: input.title,
      notes: input.notes ?? '',
      status: input.status ?? 'todo',
      createdAt: new Date().toISOString(),
      ownerEmail: input.ownerEmail ?? null,
      internalNote: 'never serialize me',
    }
    this.rows.set(task.id, task)
    return task
  }

  list(query: ListTasksInput): { data: StoredTask[]; total: number } {
    const all = [...this.rows.values()]
      .filter((t) => (query.status ? t.status === query.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { data: all.slice(query.offset, query.offset + query.limit), total: all.length }
  }

  findOne(id: string): StoredTask {
    const task = this.rows.get(id)
    if (!task) throw new NotFoundException(`No task with id ${id}`)
    return task
  }

  update(id: string, patch: UpdateTaskInput): StoredTask {
    const existing = this.findOne(id)
    const updated: StoredTask = {
      ...existing,
      ...patch,
      notes: patch.notes ?? existing.notes,
      ownerEmail: patch.ownerEmail ?? existing.ownerEmail,
    }
    this.rows.set(id, updated)
    return updated
  }
}
