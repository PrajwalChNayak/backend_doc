/**
 * `@Public()` marks a handler the ApiKeyGuard should wave through.
 *
 * A decorator in Nest is metadata plus something that reads it. `SetMetadata`
 * writes the key; the guard reads it back with `Reflector`. That is the entire
 * mechanism behind `@Roles()`, `@Public()` and every other custom decorator you
 * will see.
 */
import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_KEY = 'auth:public'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
