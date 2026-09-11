import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type CategoryDocument = HydratedDocument<Category>

@Schema({ collection: 'categories', timestamps: true })
export class Category {
  @Prop({ required: true, unique: true, trim: true })
  slug: string

  @Prop({ required: true, trim: true })
  title: string
}

export const CategorySchema = SchemaFactory.createForClass(Category)
