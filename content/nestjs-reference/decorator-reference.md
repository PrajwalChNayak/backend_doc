---
title: Decorator reference
description: Every NestJS 12 decorator grouped by kind — modules and classes, route methods, parameters, enhancer binding, OpenAPI, microservices and WebSockets — each with its package and what it does.
status: current
updated: 2026-09-11
---

Every decorator below was read from the published type declarations of `@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`, `@nestjs/platform-express@12.0.1`, `@nestjs/swagger@12.0.1`, `@nestjs/microservices@12.0.1` and `@nestjs/websockets@12.0.1`. Nothing is listed that is not exported by one of those packages. Import paths are the package root in every case — Nest does not publish deep decorator paths for you to import from.

## Modules and classes

All from `@nestjs/common` unless noted.

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@Module(metadata)` | class | Declares a module: `imports`, `controllers`, `providers`, `exports`. |
| `@Global()` | class | Makes the module's exported providers available everywhere without importing it. Use sparingly. |
| `@Injectable(options?)` | class | Marks a class as resolvable by the container. `options` carries `scope` and `durable`. |
| `@Controller()` | class | Registers the class as a controller with no path prefix. |
| `@Controller(prefix)` | class | Prefix as a `string` or `string[]`. |
| `@Controller(options)` | class | `{ path, host, version, scope, durable }`. |
| `@Inject(token?)` | constructor param, property | Injects by an explicit token instead of by type — for strings, symbols, and `forwardRef()`. |
| `@Optional()` | constructor param, property | Resolution failure yields `undefined` instead of throwing. |
| `@Catch(...exceptions)` | class | Marks an exception filter and narrows it to the listed exception types. No arguments means "catch everything". |
| `@SetMetadata(key, value)` | class, method | Attaches arbitrary metadata, read back with `Reflector`. The building block of every custom `@Roles()`-style decorator. |
| `@Dependencies(...tokens)` | class | Declares constructor dependencies explicitly. For plain JavaScript projects, where no type metadata is emitted. |
| `@Bind(...decorators)` | method | Applies parameter decorators to a method positionally. Also a plain-JavaScript affordance. |

Two helper functions live alongside them and are not decorators themselves:

| Function | Package | What it does |
| --- | --- | --- |
| `applyDecorators(...decorators)` | `@nestjs/common` | Composes several decorators into one reusable decorator. |
| `mixin(class)` | `@nestjs/common` | Registers a dynamically generated class so the container can resolve it — the pattern behind parameterized guards and interceptors. |

## Route methods

All from `@nestjs/common`. Every one takes `path?: string | string[]` — there is **no `RegExp` overload**.

| Decorator | HTTP method |
| --- | --- |
| `@Get(path?)` | GET |
| `@Post(path?)` | POST |
| `@Put(path?)` | PUT |
| `@Patch(path?)` | PATCH |
| `@Delete(path?)` | DELETE |
| `@Head(path?)` | HEAD |
| `@Options(path?)` | OPTIONS |
| `@All(path?)` | every method |
| `@Search(path?)` | SEARCH |
| `@QueryMethod(path?)` | QUERY — named this way to avoid clashing with the `@Query()` **parameter** decorator |
| `@Propfind(path?)` | PROPFIND (WebDAV) |
| `@Proppatch(path?)` | PROPPATCH (WebDAV) |
| `@Mkcol(path?)` | MKCOL (WebDAV) |
| `@Copy(path?)` | COPY (WebDAV) |
| `@Move(path?)` | MOVE (WebDAV) |
| `@Lock(path?)` | LOCK (WebDAV) |
| `@Unlock(path?)` | UNLOCK (WebDAV) |
| `@RequestMapping(metadata?)` | the underlying factory: `{ path, method }` |

### Response shaping on the handler

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@HttpCode(statusCode)` | method | Sets the success status. POST defaults to 201, everything else to 200. |
| `@Header(name, value)` | method | Sets a response header. `value` may be a `() => string` evaluated per response. |
| `@Redirect(url?, statusCode?)` | method | Redirects. Note the order — URL first, status second — which is the opposite of Express 5's `res.redirect()`. |
| `@Render(template)` | method | Renders a view with the handler's return value as the locals. Needs `setViewEngine()`. |
| `@Sse(path?, options?)` | method | Turns the handler into a Server-Sent Events stream; return an `Observable<MessageEvent>`. |
| `@Version(version)` | method | The route's version, for `enableVersioning()`. |

```ts title="src/orders/orders.controller.ts"
import { Controller, Header, HttpCode, Post } from '@nestjs/common'
import { OrdersService } from './orders.service.js'

@Controller('orders')
export class OrdersController {
  private readonly orders: OrdersService

  constructor(orders: OrdersService) {
    this.orders = orders
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async cancel() {
    await this.orders.cancel()
  }
}
```

## Parameters

All from `@nestjs/common`. Every one of `@Param()`, `@Query()`, `@Body()`, `@RawBody()` and `@Headers()` has overloads taking a property name, a list of pipes, or a `ParameterDecoratorOptions` object — `{ schema?, pipes? }`, where `schema` is any Standard Schema.

| Decorator | Yields |
| --- | --- |
| `@Req()` / `@Request()` | the platform request object (Express `Request` under `@nestjs/platform-express`) |
| `@Res(options?)` / `@Response(options?)` | the platform response object. `{ passthrough: true }` keeps Nest's response pipeline; the default `false` opts out of it entirely |
| `@Next()` | the platform `next` function |
| `@Param(name?, …)` | route parameters, or one of them |
| `@Query(name?, …)` | query-string values, or one of them |
| `@Body(name?, …)` | the parsed request body, or one property of it |
| `@RawBody(…)` | the untouched body `Buffer`. Requires the app created with `{ rawBody: true }` |
| `@Headers(name?)` | request headers, or one of them |
| `@Ip()` | `req.ip`, which honors the `trust proxy` setting |
| `@Session()` | `req.session`, populated by session middleware you mounted |
| `@HostParam(name?)` | parameters captured from `@Controller({ host })` |
| `@UploadedFile(fileKey?, …pipes)` | one uploaded file, paired with `FileInterceptor` |
| `@UploadedFiles(…pipes)` | several uploaded files, paired with `FilesInterceptor` or `FileFieldsInterceptor` |
| `@SseSignal()` | the `AbortSignal` for an SSE response's lifetime — aborted when the client disconnects, the stream completes, or it errors |

```ts title="src/users/users.controller.ts"
import { Body, Controller, Get, Headers, Ip, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { CreateUserDto } from './dto/create-user.dto.js'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Query('include') include: string | undefined,
    @Headers('accept-language') language: string | undefined,
    @Ip() ip: string,
  ) {
    return this.users.findOne(id, { include, language, ip })
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }
}
```

`createParamDecorator(factory, enhancers?)` from `@nestjs/common` builds your own. It is the mechanism behind every `@CurrentUser()` in every Nest codebase — see [Custom decorators](../nestjs-request-handling/custom-decorators.md).

### File upload interceptors

These are interceptor **factories** from `@nestjs/platform-express`, used inside `@UseInterceptors()`, and they are what make `@UploadedFile()` and `@UploadedFiles()` produce anything. They wrap `multer` 2.2.0, which the platform package pins.

| Factory | What it accepts |
| --- | --- |
| `FileInterceptor(fieldName, options?)` | one file on one field |
| `FilesInterceptor(fieldName, maxCount?, options?)` | several files on one field |
| `FileFieldsInterceptor(uploadFields, options?)` | several named fields, each with its own `maxCount` |
| `AnyFilesInterceptor(options?)` | every file on any field |
| `NoFilesInterceptor(options?)` | no files — rejects a multipart request that carries any |

## Binding guards, interceptors, pipes and filters

All from `@nestjs/common`. Each accepts classes (so the container instantiates and injects them) or already-constructed instances.

| Decorator | Applies to | Binds |
| --- | --- | --- |
| `@UseGuards(...guards)` | class, method | `CanActivate` implementations — authorization, authentication, throttling |
| `@UseInterceptors(...interceptors)` | class, method | `NestInterceptor` implementations — caching, timeouts, serialization, file uploads |
| `@UsePipes(...pipes)` | class, method | `PipeTransform` implementations, applied to every parameter of the handler |
| `@UseFilters(...filters)` | class, method | `ExceptionFilter` implementations |
| `@SerializeOptions(options)` | class, method | Options for `ClassSerializerInterceptor` (`groups`, `excludeExtraneousValues`, …) or for `StandardSchemaSerializerInterceptor` (`{ schema, validateOptions }`) |

Within each stage, narrower wins later: **global → controller → method**. Nothing above registers a *global* enhancer; that is `app.useGlobalGuards()` and friends, or the injection tokens from `@nestjs/core`:

| Token | Package | Registers |
| --- | --- | --- |
| `APP_GUARD` | `@nestjs/core` | a global guard that can inject dependencies |
| `APP_INTERCEPTOR` | `@nestjs/core` | a global interceptor |
| `APP_PIPE` | `@nestjs/core` | a global pipe |
| `APP_FILTER` | `@nestjs/core` | a global exception filter |

```ts title="src/app.module.ts"
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_GUARD, APP_PIPE } from '@nestjs/core'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [
    { provide: APP_PIPE, useClass: ValidationPipe },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

## OpenAPI

All from `@nestjs/swagger` (12.0.1).

| Decorator | Applies to | What it documents |
| --- | --- | --- |
| `@ApiTags(...tags)` | class, method | Groups operations under one or more tags. |
| `@ApiOperation(options)` | method | `summary`, `description`, `operationId`, `deprecated`. |
| `@ApiResponse(options)` | class, method | One response: status, description, `type`. |
| `@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiNoContentResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiConflictResponse`, `@ApiTooManyRequestsResponse`, `@ApiInternalServerErrorResponse`, … | class, method | Status-specific shorthands for `@ApiResponse`. One exists for essentially every HTTP status. |
| `@ApiDefaultResponse(options)` | class, method | The OpenAPI `default` response. |
| `@ApiParam(options)` | class, method | A path parameter. |
| `@ApiQuery(options)` | class, method | A query parameter. |
| `@ApiBody(options)` | method | The request body schema. |
| `@ApiHeader(options)` / `@ApiHeaders(headers)` | class, method | Request headers. |
| `@ApiConsumes(...mimeTypes)` | class, method | Accepted request content types — `multipart/form-data` for uploads. |
| `@ApiProduces(...mimeTypes)` | class, method | Response content types. |
| `@ApiProperty(options?)` | property | Documents a DTO property. |
| `@ApiPropertyOptional(options?)` | property | Same, marked optional. |
| `@ApiResponseProperty(options?)` | property | A response-only property: `type`, `example`, `format`, `deprecated`, `enum`. |
| `@ApiHideProperty()` | property | Excludes a property from the schema. |
| `@ApiSchema(options?)` | class | Overrides the generated schema name. |
| `@ApiExtraModels(...models)` | class, method | Registers models referenced only indirectly, e.g. through `oneOf`. |
| `@ApiExcludeEndpoint(disable?)` / `@ApiIncludeEndpoint(disable?)` | method | Hides or re-includes one operation. |
| `@ApiExcludeController(disable?)` | class | Hides a whole controller. |
| `@ApiExtension(key, properties)` | class, method | An `x-` vendor extension. |
| `@ApiCallbacks(...callbacks)` | class, method | OpenAPI callbacks. |
| `@ApiLink(options)` | method | An OpenAPI link between operations. |
| `@ApiWebhook(name?)` | method | Declares the operation as a webhook. |
| `@ApiDefaultGetter(type, parameter)` | method | Marks the operation as the canonical getter for a type, used when generating links. |
| `@ApiBearerAuth(name?)` | class, method | Bearer security requirement. |
| `@ApiBasicAuth(name?)` | class, method | HTTP basic security requirement. |
| `@ApiCookieAuth(name?)` | class, method | Cookie security requirement. |
| `@ApiOAuth2(scopes, name?)` | class, method | OAuth2 security requirement. |
| `@ApiSecurity(name, requirements?)` | class, method | Any named security scheme declared on the document. |

Full setup, including `DocumentBuilder` and the CLI plugin that infers most of this from your types: [OpenAPI with Swagger](../nestjs-libraries/swagger.md).

## Microservices

All from `@nestjs/microservices` (12.0.1).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@MessagePattern(pattern, transport?, extras?)` | method | Handles a request-response message matching the pattern. |
| `@EventPattern(pattern, transport?, extras?)` | method | Handles a fire-and-forget event. No response is sent. |
| `@Payload(property?, …)` | parameter | The message payload, or one property of it. Takes pipes and `ParameterDecoratorOptions` like `@Body()`. |
| `@Ctx()` | parameter | The transport-specific context object — `RmqContext`, `KafkaContext`, `NatsContext` and friends. |
| `@Client(metadata?)` | property | Injects a `ClientProxy` built from the given `ClientOptions`. |
| `@GrpcMethod(service?, method?)` | method | Handles a unary gRPC call. |
| `@GrpcStreamMethod(service?, method?)` | method | Handles a gRPC stream as an RxJS `Observable`. |
| `@GrpcStreamCall(service?, method?)` | method | Handles a gRPC stream as the raw call object. |
| `@GrpcService(…)` | class | A gRPC service controller — an alias of `@Controller()`. |

:::note
NestJS 12's NATS transport is built against `@nats-io/transport-node` 3.4.0, and custom deserializers now receive the full NATS message object — read the payload with `msg.json()`. See [NestJS 11 → 12 migration](v11-to-v12-migration.md).
:::

## WebSockets

All from `@nestjs/websockets` (12.0.1), used with a platform adapter such as `@nestjs/platform-socket.io` (12.0.1).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@WebSocketGateway(port?, options?)` | class | Declares a gateway. Also accepts a single options object. |
| `@WebSocketServer()` | property | Injects the underlying server instance. |
| `@SubscribeMessage(message)` | method | Handles one named client message. |
| `@MessageBody(property?, …)` | parameter | The message payload, or one property of it. Takes pipes and `ParameterDecoratorOptions`. |
| `@ConnectedSocket()` | parameter | The client socket the message arrived on. |
| `@Ack()` | parameter | The acknowledgement callback, for clients that send one. |

See [WebSockets](../nestjs-advanced/websockets.md).

## Common mistakes

- **Using `@Query()` as a route method.** The QUERY *HTTP method* decorator is `@QueryMethod()`; `@Query()` reads the query string.
- **Injecting `@Res()` and returning a value.** The return value is discarded and the request hangs. `@Res({ passthrough: true })` is almost always what you meant.
- **Expecting `@SetMetadata()` to do something on its own.** It only attaches metadata; a guard or interceptor has to read it with `Reflector`.
- **Reaching for `@UsePipes()` to validate one parameter.** It applies to every parameter of the handler. Put the pipe on the parameter instead.
- **Using `@Global()` to avoid writing `imports`.** It makes the module graph unreadable and hides real coupling.
- **Assuming a route decorator takes a `RegExp`.** None of them does. Match loosely and validate in a pipe.
- **Using `@RawBody()` without `{ rawBody: true }`.** It yields `undefined`, silently.

## Related topics

- [Cheat sheet](cheat-sheet.md) — the same surface as runnable skeletons.
- [Controllers](../nestjs/controllers.md) — route and parameter decorators in context.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — `createParamDecorator` and `applyDecorators`.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the order the binding decorators feed into.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — the `@Api*` family with a working document.
- [Microservices and transports](../nestjs-advanced/microservices.md) — patterns, payloads and contexts.
- [WebSockets](../nestjs-advanced/websockets.md) — gateways end to end.
- [NestJS 11 → 12 migration](v11-to-v12-migration.md) — what is new in this surface.
