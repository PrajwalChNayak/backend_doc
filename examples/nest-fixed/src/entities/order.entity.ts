import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm'
import { User } from './user.entity.js'

@Entity({ name: 'orders' })
export class Order {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 200 })
  description: string

  @Column({ name: 'total_cents', type: 'integer' })
  totalCents: number

  // Sensitive fields the IDOR in nest-vulnerable leaked; here the lookup is owner-scoped.
  @Column({ name: 'shipping_address', type: 'varchar', length: 300 })
  shippingAddress: string

  @Column({ name: 'card_last4', type: 'varchar', length: 4 })
  cardLast4: string

  @ManyToOne(() => User, (user) => user.orders, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  @Index()
  owner: User

  @Column({ name: 'user_id' })
  userId: number

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date
}
