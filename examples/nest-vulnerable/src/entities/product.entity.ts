// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'products' })
export class Product {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 200 })
  name: string

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents: number
}
