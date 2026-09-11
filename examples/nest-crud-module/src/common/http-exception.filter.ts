/**
 * One place that decides what a failure looks like on the wire.
 *
 * `@Catch()` with no argument catches everything, so this replaces Nest's
 * built-in filter entirely: HttpExceptions keep their status, anything else
 * becomes a 500 whose body never contains the original message or stack.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import type { Request, Response } from 'express'

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
    requestId?: string
  }
}

/** BadRequest from the ValidationPipe carries `message: string[]`. */
function describe(exception: HttpException): { code: string; message: string; details?: unknown } {
  const payload = exception.getResponse()
  const status = exception.getStatus()

  if (typeof payload === 'string') {
    return { code: HttpStatus[status] ?? 'ERROR', message: payload }
  }

  const body = payload as { message?: string | string[]; error?: string }
  if (Array.isArray(body.message)) {
    return {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: body.message,
    }
  }
  return {
    code: (body.error ?? HttpStatus[status] ?? 'ERROR').toUpperCase().replace(/\s+/g, '_'),
    message: body.message ?? exception.message,
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const response = http.getResponse<Response>()
    const request = http.getRequest<Request>()
    const requestId = response.getHeader('x-request-id')

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const described = describe(exception)
      const body: ErrorBody = {
        error: {
          ...described,
          ...(typeof requestId === 'string' ? { requestId } : {}),
        },
      }
      response.status(status).json(body)
      return
    }

    // Anything that is not an HttpException is a bug, not a client error.
    this.logger.error(
      `unhandled error on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    )
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong',
        ...(typeof requestId === 'string' ? { requestId } : {}),
      },
    } satisfies ErrorBody)
  }
}
