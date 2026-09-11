/**
 * An in-memory repository so the example needs nothing external. The interface
 * is the point: the service talks to `TasksRepository`, and swapping this for
 * `nest-typeorm`'s repository changes nothing above this file.
 */
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Task, TaskStatus } from './task.entity.js'

export interface ListCriteria {
  status?: TaskStatus
  limit: number
  offset: number
}

@Injectable()
export class TasksRepository {
  private readonly rows = new Map<string, Task>()

  constructor() {
    this.insert({ title: 'Read the request pipeline docs', status: 'doing', notes: '' })
    this.insert({ title: 'Write a DTO for every route', status: 'todo', notes: '' })
    this.insert({ title: 'Delete the last any', status: 'done', notes: '' })
  }

  insert(input: { title: string; notes?: string; status?: TaskStatus }): Task {
    const now = new Date().toISOString()
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      notes: input.notes ?? '',
      status: input.status ?? 'todo',
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(task.id, task)
    return task
  }

  findById(id: string): Task | undefined {
    return this.rows.get(id)
  }

  list(criteria: ListCriteria): { rows: Task[]; total: number } {
    const all = [...this.rows.values()]
      .filter((t) => (criteria.status ? t.status === criteria.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return {
      rows: all.slice(criteria.offset, criteria.offset + criteria.limit),
      total: all.length,
    }
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | undefined {
    const existing = this.rows.get(id)
    if (!existing) return undefined
    const updated: Task = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    this.rows.set(id, updated)
    return updated
  }

  remove(id: string): boolean {
    return this.rows.delete(id)
  }
}
