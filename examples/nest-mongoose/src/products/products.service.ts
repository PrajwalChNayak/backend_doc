import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types, isValidObjectId } from 'mongoose'
import { Category, CategoryDocument } from './category.schema.js'
import { Product, ProductDocument } from './product.schema.js'
import type { CreateProductDto } from './dto.js'

/** Escapes a user string so it cannot act as a regular expression. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Category.name) private readonly categories: Model<CategoryDocument>,
  ) {}

  async seed(): Promise<void> {
    const category = await this.categories.findOneAndUpdate(
      { slug: 'hardware' },
      { $setOnInsert: { slug: 'hardware', title: 'Hardware' } },
      { upsert: true, new: true },
    )
    const fixtures = [
      { name: 'Mechanical keyboard', sku: 'KB-001', priceCents: 12900, tags: ['input'] },
      { name: '27-inch monitor', sku: 'MON-027', priceCents: 34900, tags: ['display'] },
      { name: 'USB-C dock', sku: 'DOCK-11', priceCents: 19900, tags: ['dock', 'usb'] },
    ]
    for (const fixture of fixtures) {
      await this.products.updateOne(
        { sku: fixture.sku },
        { $setOnInsert: { ...fixture, categoryId: category._id } },
        { upsert: true },
      )
    }
  }

  async list(limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      this.products.find().sort({ sku: 1 }).skip(offset).limit(limit).lean().exec(),
      this.products.countDocuments().exec(),
    ])
    return { data: rows, meta: { total, limit, offset } }
  }

  async findOne(id: string) {
    // An id that is not an ObjectId would make Mongoose throw a CastError, which
    // surfaces as a 500. Check first and answer 404.
    if (!isValidObjectId(id)) throw new NotFoundException(`No product with id ${id}`)
    const product = await this.products
      .findById(new Types.ObjectId(id))
      .populate('categoryId', 'slug title')
      .lean()
      .exec()
    if (!product) throw new NotFoundException(`No product with id ${id}`)
    return product
  }

  /**
   * NoSQL injection defence, two parts.
   *
   * 1. `$eq` pins the comparison to equality. Express parses `?sku[$ne]=x` into
   *    the OBJECT `{ $ne: 'x' }`; passing that straight into `find({ sku })`
   *    would run an operator the caller chose. `{ $eq: value }` cannot, and the
   *    String() call makes sure the value is a scalar in the first place.
   * 2. The name search escapes the input before it becomes a RegExp, so `.*`
   *    is three literal characters and not a table scan the caller controls.
   */
  async search(term: string) {
    const value = String(term)
    const rows = await this.products
      .find({
        $or: [
          { sku: { $eq: value } },
          { name: { $regex: new RegExp(escapeRegex(value), 'i') } },
        ],
      })
      .limit(20)
      .lean()
      .exec()
    return { data: rows }
  }

  async create(dto: CreateProductDto) {
    try {
      const created = await this.products.create({
        name: dto.name,
        sku: dto.sku,
        priceCents: dto.priceCents,
        tags: dto.tags ?? [],
      })
      return created.toObject()
    } catch (err) {
      // 11000 is the duplicate-key error code from the unique index.
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException(`sku ${dto.sku} already exists`)
      }
      throw err
    }
  }

  async remove(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException(`No product with id ${id}`)
    const result = await this.products.deleteOne({ _id: new Types.ObjectId(id) }).exec()
    if (result.deletedCount === 0) throw new NotFoundException(`No product with id ${id}`)
  }
}
