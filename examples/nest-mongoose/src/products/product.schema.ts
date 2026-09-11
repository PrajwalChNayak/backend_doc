/**
 * `@Schema()` + `@Prop()` describe a Mongoose schema with decorators, and
 * `SchemaFactory.createForClass` turns the class into the real schema object.
 * The `HydratedDocument` type is what a query actually returns.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'

export type ProductDocument = HydratedDocument<Product>

@Schema({
  collection: 'products',
  timestamps: true,
  // Strict mode is the default and worth keeping: a key the schema does not
  // declare is dropped rather than written, which is the mass-assignment
  // defence at the storage layer.
  strict: true,
})
export class Product {
  @Prop({ required: true, trim: true, maxlength: 200 })
  name: string

  @Prop({ required: true, unique: true, index: true, trim: true })
  sku: string

  @Prop({ required: true, min: 0 })
  priceCents: number

  @Prop({ type: [String], default: [] })
  tags: string[]

  @Prop({ type: Types.ObjectId, ref: 'Category' })
  categoryId?: Types.ObjectId
}

export const ProductSchema = SchemaFactory.createForClass(Product)
