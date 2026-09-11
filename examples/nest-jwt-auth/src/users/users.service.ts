/**
 * An in-memory user store so the example needs no database. The shape is what
 * matters: a record holds a password HASH and a role, and nothing that leaves
 * this service ever carries the hash.
 */
import { Injectable, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '../lib/password.js'

export type Role = 'user' | 'admin'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  roles: Role[]
}

export interface PublicUser {
  id: string
  username: string
  roles: Role[]
}

const SEED: Array<{ username: string; password: string; roles: Role[] }> = [
  { username: 'alice', password: 'correct-horse-battery-staple', roles: ['user'] },
  { username: 'root', password: 'admin-password-not-for-production', roles: ['user', 'admin'] },
]

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly byUsername = new Map<string, UserRecord>()
  private readonly byId = new Map<string, UserRecord>()

  async onModuleInit(): Promise<void> {
    for (const seed of SEED) {
      const record: UserRecord = {
        id: randomUUID(),
        username: seed.username,
        passwordHash: await hashPassword(seed.password),
        roles: seed.roles,
      }
      this.byUsername.set(record.username, record)
      this.byId.set(record.id, record)
    }
  }

  findByUsername(username: string): UserRecord | undefined {
    return this.byUsername.get(username)
  }

  findById(id: string): UserRecord | undefined {
    return this.byId.get(id)
  }

  /** The only shape allowed out of this service. */
  static toPublic(user: UserRecord): PublicUser {
    return { id: user.id, username: user.username, roles: user.roles }
  }

  count(): number {
    return this.byId.size
  }
}
