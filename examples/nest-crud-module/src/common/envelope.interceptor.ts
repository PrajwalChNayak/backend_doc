/**
 * An interceptor wraps the handler: code before `next.handle()` runs on the way
 * in, the RxJS operators run on the way out. This one gives every successful
 * response the same `{ data, meta }` shape and times the handler.
 *
 * Errors do not pass through `map()` — they go to the exception filter — which
 * is why success and failure bodies are defined in two different files.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Observable, map } from 'rxjs'
import type { Request, Response } from 'express'

export interface Envelope<T> {
  data: T
  meta: Record<string, unknown>
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()

    const requestId = request.header('x-request-id') ?? randomUUID()
    const startedAt = process.hrtime.bigint()
    response.setHeader('x-request-id', requestId)

    return next.handle().pipe(
      map((value) => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        response.setHeader('x-response-time-ms', durationMs.toFixed(3))

        // A 204 handler returns undefined. Wrapping that would write a body on
        // a response that is defined to have none.
        if (value === undefined) return value

        // A handler that already built its own meta (paginated lists) keeps it.
        if (value && typeof value === 'object' && 'data' in (value as object)) {
          const partial = value as { data: unknown; meta?: Record<string, unknown> }
          return {
            data: partial.data,
            meta: { ...partial.meta, requestId, durationMs: Number(durationMs.toFixed(3)) },
          }
        }
        return { data: value, meta: { requestId, durationMs: Number(durationMs.toFixed(3)) } }
      }),
    )
  }
}
