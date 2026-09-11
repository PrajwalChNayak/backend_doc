/**
 * Repository injection, one relation, one transaction, and nothing built by
 * string concatenation.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { Post } from '../posts/post.entity.js'
import { User } from './user.entity.js'
import type { CreateUserDto, CreateUserWithPostsDto } from './dto.js'

/** Columns a client may sort by. An unknown value is a 400, never SQL. */
export const SORTABLE = new Set(['id', 'email', 'name', 'createdAt'])

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code ??
    (err as { driverError?: { code?: string } })?.driverError?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT'
}

@Injectable()
export class UsersService {
  constructor(
    // `@InjectRepository(User)` resolves the repository token that
    // `TypeOrmModule.forFeature([User])` registered in this module.
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Post) private readonly posts: Repository<Post>,
    // The DataSource is what you need for a transaction that spans repositories.
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async list(sort: string, limit: number, offset: number) {
    if (!SORTABLE.has(sort)) {
      throw new BadRequestException(`Cannot sort by ${sort}`)
    }
    // `order` takes a property name of the entity, not a SQL fragment. TypeORM
    // maps it to the column and quotes it, so there is no interpolation here.
    const [rows, total] = await this.users.findAndCount({
      order: { [sort]: 'ASC' } as Record<string, 'ASC'>,
      take: limit,
      skip: offset,
    })
    return { data: rows, meta: { total, limit, offset, sort } }
  }

  /**
   * `relations` performs the join for you. Without it `user.posts` is
   * undefined — TypeORM does not lazy-load unless the property is a Promise.
   */
  async findOne(id: number): Promise<User> {
    const user = await this.users.findOne({
      where: { id },
      relations: { posts: true },
      order: { posts: { id: 'ASC' } },
    })
    if (!user) throw new NotFoundException(`No user with id ${id}`)
    return user
  }

  /**
   * The query builder with a NAMED bind parameter. `:email` is sent to SQLite
   * as a placeholder with the value bound separately — the string
   * `' OR 1=1 --` is looked up as an email address and finds nothing.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('user')
      .where('user.email = :email', { email })
      .getOne()
  }

  /**
   * An aggregate over the relation, still fully parameterised. `getRawMany`
   * returns the raw result rows rather than entities.
   */
  async authorsWithAtLeast(minPosts: number) {
    return this.users
      .createQueryBuilder('user')
      .leftJoin('user.posts', 'post')
      .select('user.id', 'id')
      .addSelect('user.name', 'name')
      .addSelect('COUNT(post.id)', 'postCount')
      .groupBy('user.id')
      .having('COUNT(post.id) >= :minPosts', { minPosts })
      .orderBy('user.id', 'ASC')
      .getRawMany()
  }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      return await this.users.save(this.users.create({ ...dto }))
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`${dto.email} is already registered`)
      throw err
    }
  }

  /**
   * One transaction across two tables. `dataSource.transaction()` opens a
   * query runner, hands you a manager bound to it, commits when the callback
   * resolves and rolls back when it throws — including the user INSERT, which
   * is the point: a half-created user with no posts never becomes visible.
   */
  async createWithPosts(dto: CreateUserWithPostsDto): Promise<User> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const user = await manager.save(manager.create(User, { email: dto.email, name: dto.name }))
        const posts = dto.posts.map((p) =>
          manager.create(Post, { title: p.title, body: p.body ?? '', userId: user.id }),
        )
        await manager.save(posts)
        return manager.findOneOrFail(User, { where: { id: user.id }, relations: { posts: true } })
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`${dto.email} is already registered`)
      throw err
    }
  }

  async listPosts(limit: number) {
    return this.posts.find({
      relations: { author: true },
      order: { id: 'ASC' },
      take: limit,
    })
  }
}
