// !!! DELIBERATELY VULNERABLE — DO NOT COPY !!!
import { Controller, Get, Headers, NotFoundException, Param } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Order } from './entities/order.entity.js'

@Controller('orders')
export class OrdersController {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  /**
   * "Authentication", such as it is: the caller announces who they are in a
   * header and the server believes them. Real auth is in examples/nest-jwt-auth;
   * the header keeps this example short so the IDOR is the only thing to look at.
   */
  private currentUserId(header?: string): number {
    const id = Number(header ?? 1)
    return Number.isInteger(id) && id > 0 ? id : 1
  }

  /** Scoped correctly — this one is fine, and exists for contrast. */
  @Get()
  async list(@Headers('x-user-id') userIdHeader?: string) {
    const userId = this.currentUserId(userIdHeader)
    const rows = await this.orders.find({ where: { userId }, order: { id: 'ASC' } })
    return { userId, rows }
  }

  /**
   * VULNERABLE — INSECURE DIRECT OBJECT REFERENCE.
   *
   * The lookup is by id ALONE. The caller's identity is read, logged, and then
   * ignored. Any authenticated user can read every order in the system by
   * counting from 1, and the response carries a shipping address and a card
   * suffix. See exploit.md.
   *
   * The fix is in examples/nest-fixed: scope the WHERE clause by owner and
   * return 404 (not 403) when it does not match.
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Headers('x-user-id') userIdHeader?: string) {
    const callerId = this.currentUserId(userIdHeader)
    const order = await this.orders.findOne({ where: { id: Number(id) } })
    if (!order) throw new NotFoundException(`No order with id ${id}`)
    return { requestedBy: callerId, order }
  }
}
