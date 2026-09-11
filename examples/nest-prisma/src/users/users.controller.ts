import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post as HttpPost,
  Query,
} from '@nestjs/common'
import { CreateUserDto, CreateUserWithPostsDto } from './dto.js'
import { UsersService } from './users.service.js'

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  list(
    @Query('sort', new DefaultValuePipe('id')) sort: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    if (limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100')
    return this.users.list(sort, limit, offset)
  }

  @Get('users/search')
  async search(@Query('email') email?: string) {
    if (!email) throw new BadRequestException('email is required')
    return { data: await this.users.findByEmail(email) }
  }

  @Get('users/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id)
  }

  @Get('users/:id/posts')
  async postsOf(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.findOne(id)
    return { data: user.posts }
  }

  @HttpPost('users')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }

  @HttpPost('users-with-posts')
  createWithPosts(@Body() dto: CreateUserWithPostsDto) {
    return this.users.createWithPosts(dto)
  }

  @Get('posts')
  async listPosts(@Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return { data: await this.users.listPosts(limit) }
  }

  @Get('stats/authors')
  async stats(@Query('minPosts', new DefaultValuePipe(1), ParseIntPipe) minPosts: number) {
    const rows = (await this.users.authorsWithAtLeast(minPosts)) as Array<Record<string, unknown>>
    // SQLite returns COUNT() as a BigInt through some drivers, and JSON.stringify
    // throws on BigInt. Normalise at the edge rather than hoping.
    return {
      data: rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        postCount: Number(row.postCount),
      })),
    }
  }
}
