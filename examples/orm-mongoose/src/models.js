/**
 * Mongoose schemas for the same users/posts domain the SQL examples use.
 *
 * MongoDB has no schema of its own — Mongoose's is enforced in your process, on
 * write. That is a real difference from an SQL ORM: a document written by any
 * other client (mongosh, a Python service, a migration script) never went
 * through these rules. Treat the schema as validation, and the `unique` index as
 * the only constraint the database itself will hold.
 */
import mongoose from 'mongoose'

const { Schema, model } = mongoose

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      // `unique` is NOT a validator — it asks Mongoose to build a unique index.
      // The duplicate is rejected by MongoDB (E11000), not by Mongoose.
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    // `strict: 'throw'` rejects a write containing a field the schema does not
    // declare. The default (`true`) silently drops it, which hides typos and
    // makes "why did my field not save?" a recurring support question.
    strict: 'throw',
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString()
        delete ret._id
        return ret
      },
    },
  },
)

// A virtual populate: `posts` is not stored on the user document, it is a
// reverse lookup. It costs a second query and only runs when you ask for it.
userSchema.virtual('posts', {
  ref: 'Post',
  localField: '_id',
  foreignField: 'author',
})

const postSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, default: '', maxlength: 5000 },
    // The reference. Mongo has no foreign keys and no ON DELETE CASCADE, so
    // deleting a user has to delete the posts explicitly — see DELETE /users/:id.
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  {
    timestamps: true,
    strict: 'throw',
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString()
        delete ret._id
        return ret
      },
    },
  },
)

export const User = model('User', userSchema)
export const Post = model('Post', postSchema)

/** Fields a client may sort by — see the note in app.js about `sort` strings. */
export const SORTABLE_USER_FIELDS = new Set(['createdAt', 'email', 'name'])
