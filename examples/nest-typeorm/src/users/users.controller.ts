import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
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
    const user = await this.users.findByEmail(email)
    // A lookup that finds nothing is an empty result, not an error — the client
    // asked "is this address taken", and "no" is an answer.
    return { data: user }
  }

  @Get('users/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id)
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
    return { data: await this.users.authorsWithAtLeast(minPosts) }
  }

  @Get('users/:id/posts')
  async postsOf(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.findOne(id)
    if (!user) throw new NotFoundException(`No user with id ${id}`)
    return { data: user.posts }
  }
}
