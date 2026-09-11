import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm'
import { User } from '../users/user.entity.js'

@Entity({ name: 'posts' })
export class Post {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 200 })
  title: string

  @Column({ type: 'text', default: '' })
  body: string

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  /**
   * The owning side: this is where the `user_id` column and the foreign key
   * actually live. `onDelete: 'CASCADE'` is a database constraint, not
   * application code — SQLite only enforces it when `PRAGMA foreign_keys = ON`,
   * which the data source sets on every connection.
   */
  @ManyToOne(() => User, (user) => user.posts, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  @Index()
  author: User

  @Column({ name: 'user_id' })
  userId: number
}
