/**
 * A TypeORM entity is a class whose decorators describe a table. This is the
 * decorator API — it needs `experimentalDecorators` and `emitDecoratorMetadata`,
 * which a Nest project already has. (TypeORM's decorator-free `EntitySchema`
 * API exists for projects that cannot compile; see `examples/orm-typeorm`.)
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm'
import { Post } from '../posts/post.entity.js'

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id: number

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320 })
  email: string

  @Column({ type: 'varchar', length: 120 })
  name: string

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  /**
   * The inverse side. It creates no column — the foreign key lives on `posts`.
   * Loading it costs a second query unless you ask for it with `relations` or
   * a join in the query builder.
   */
  @OneToMany(() => Post, (post) => post.author)
  posts: Post[]
}
