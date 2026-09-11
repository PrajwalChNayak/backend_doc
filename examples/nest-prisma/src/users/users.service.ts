import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CreateUserDto, CreateUserWithPostsDto } from './dto.js'

/**
 * Prisma's `orderBy` takes a key of the generated type, not a string that
 * reaches SQL — an unknown key is a TypeScript/runtime client error, never an
 * injection. The Set turns it into a clean 400.
 */
export const SORTABLE = new Set(['id', 'email', 'name', 'createdAt'])

/** P2002 = unique constraint, P2025 = record not found. */
function prismaCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(sort: string, limit: number, offset: number) {
    if (!SORTABLE.has(sort)) throw new BadRequestException(`Cannot sort by ${sort}`)
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        orderBy: { [sort]: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count(),
    ])
    return { data: rows, meta: { total, limit, offset, sort } }
  }

  /** `include` is the eager load. Turn on PRISMA_LOG=query to see it cost two statements. */
  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { posts: { orderBy: { id: 'asc' } } },
    })
    if (!user) throw new NotFoundException(`No user with id ${id}`)
    return user
  }

  /**
   * A `where` clause built from a value, not a string. Prisma compiles this to
   * a parameterised statement — there is no code path where `email` becomes SQL.
   */
  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } })
  }

  async create(dto: CreateUserDto) {
    try {
      return await this.prisma.user.create({ data: { email: dto.email, name: dto.name } })
    } catch (err) {
      if (prismaCode(err) === 'P2002') {
        throw new ConflictException(`${dto.email} is already registered`)
      }
      throw err
    }
  }

  /**
   * An INTERACTIVE transaction. Everything inside the callback uses `tx`, runs
   * on one connection, and commits or rolls back as a unit. Calling
   * `this.prisma.*` inside here instead of `tx.*` runs outside the transaction —
   * that is the bug to watch for.
   */
  async createWithPosts(dto: CreateUserWithPostsDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: dto.email, name: dto.name } })
        await tx.post.createMany({
          data: dto.posts.map((p) => ({ title: p.title, body: p.body ?? '', userId: user.id })),
        })
        return tx.user.findUniqueOrThrow({
          where: { id: user.id },
          include: { posts: { orderBy: { id: 'asc' } } },
        })
      })
    } catch (err) {
      if (prismaCode(err) === 'P2002') {
        throw new ConflictException(`${dto.email} is already registered`)
      }
      throw err
    }
  }

  async listPosts(limit: number) {
    return this.prisma.post.findMany({
      take: limit,
      orderBy: { id: 'asc' },
      include: { author: { select: { id: true, name: true } } },
    })
  }

  /**
   * The raw escape hatch, done correctly: `$queryRaw` is a TAGGED TEMPLATE, so
   * every `${}` inside it becomes a bind parameter. The dangerous sibling is
   * `$queryRawUnsafe()`, an ordinary function call whose argument is just a
   * string — never build one from user input.
   */
  async authorsWithAtLeast(minPosts: number) {
    return this.prisma.$queryRaw`
      SELECT u.id AS id, u.name AS name, COUNT(p.id) AS postCount
      FROM users u
      LEFT JOIN posts p ON p.user_id = u.id
      GROUP BY u.id
      HAVING COUNT(p.id) >= ${minPosts}
      ORDER BY u.id ASC
    `
  }
}
