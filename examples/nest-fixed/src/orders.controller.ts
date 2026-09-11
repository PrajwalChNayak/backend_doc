import { Controller, Get, Headers, NotFoundException, Param, ParseIntPipe } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Order } from './entities/order.entity.js'

@Controller('orders')
export class OrdersController {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  /**
   * Still a header for brevity — real auth is in examples/nest-jwt-auth. The
   * point of this example is the authorization check, not the authentication.
   */
  private currentUserId(header?: string): number {
    const id = Number(header ?? 1)
    return Number.isInteger(id) && id > 0 ? id : 1
  }

  @Get()
  async list(@Headers('x-user-id') userIdHeader?: string) {
    const userId = this.currentUserId(userIdHeader)
    const rows = await this.orders.find({ where: { userId }, order: { id: 'ASC' } })
    return { userId, rows }
  }

  /**
   * FIXED: the WHERE clause is scoped by owner. An order that exists but belongs
   * to someone else is indistinguishable from one that does not exist — both are
   * 404.
   *
   * 404, not 403: a 403 confirms the id exists, which is a free enumeration
   * oracle. Because `userId` is in the WHERE clause, there is no code path that
   * could return another user's row in the first place.
   */
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-user-id') userIdHeader?: string,
  ) {
    const userId = this.currentUserId(userIdHeader)
    const order = await this.orders.findOne({ where: { id, userId } })
    if (!order) throw new NotFoundException(`No order with id ${id}`)
    return { requestedBy: userId, order }
  }
}
