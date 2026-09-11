// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
// This project is a teaching target for examples/nest-fixed. Every file in it
// contains at least one exploitable mistake on purpose.
import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm'
import { Order } from './order.entity.js'

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id: number

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320 })
  email: string

  @Column({ type: 'varchar', length: 120 })
  name: string

  // A password reset token in the users table. It is here so the SQL-injection
  // exploit in exploit.md has something genuinely damaging to steal.
  @Column({ type: 'varchar', length: 64, default: '' })
  resetToken: string

  @OneToMany(() => Order, (order) => order.owner)
  orders: Order[]
}
