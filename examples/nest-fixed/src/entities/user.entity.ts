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

  // A password reset token in the users table — the SQL-injection exploit in
  // nest-vulnerable stole this; here every query that could reach it is parameterised.
  @Column({ type: 'varchar', length: 64, default: '' })
  resetToken: string

  @OneToMany(() => Order, (order) => order.owner)
  orders: Order[]
}
