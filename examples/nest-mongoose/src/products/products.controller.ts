import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common'
import { CreateProductDto } from './dto.js'
import { ProductsService } from './products.service.js'

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    if (limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100')
    return this.products.list(limit, offset)
  }

  @Get('search')
  search(@Query('q') q?: unknown) {
    // `?q[$ne]=` arrives as an object. Reject it here rather than hoping the
    // query layer copes — a search term is a string.
    if (typeof q !== 'string' || q.length === 0) {
      throw new BadRequestException('q must be a non-empty string')
    }
    return this.products.search(q)
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.products.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.products.remove(id)
  }
}
