---
title: WebSockets
description: Gateways with @nestjs/websockets 12 and the Socket.IO platform — the decorators, lifecycle hooks, how guards and pipes differ from HTTP, authenticating at the handshake, rooms, and scaling a gateway across instances with the Redis adapter.
status: current
updated: 2026-09-11
---

A gateway is a class decorated with `@WebSocketGateway()` whose methods are bound to message names instead of routes. Everything DI gives a controller it also gives a gateway; what it does **not** give you is the HTTP request pipeline, and the places where that assumption breaks are where every WebSocket bug in a Nest application comes from.

## Installation

```bash
npm install @nestjs/websockets@12 @nestjs/platform-socket.io@12
```

`@nestjs/platform-socket.io@12.0.1` bundles `socket.io@4.8.3` — you do not install it separately. `@nestjs/websockets` declares `@nestjs/platform-socket.io` as a peer, so both are required even if you later swap the adapter.

## A gateway

```ts title="src/chat/chat.gateway.ts"
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets'
import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'
import { ChatService } from './chat.service.js'

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: ['https://app.example.com'], credentials: true },
  maxHttpBufferSize: 64 * 1024,
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name)
  private readonly chat: ChatService

  @WebSocketServer()
  server: Server

  constructor(chat: ChatService) {
    this.chat = chat
  }

  afterInit(server: Server) {
    this.logger.log(`chat namespace ready with ${server.engine.clientsCount} clients`)
  }

  handleConnection(client: Socket) {
    this.logger.log(`connected ${client.id}`)
  }

  handleDisconnect(client: Socket, reason?: string) {
    this.logger.log(`disconnected ${client.id} (${reason})`)
  }

  @SubscribeMessage('message')
  async onMessage(
    @MessageBody() body: { roomId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const message = await this.chat.post(client.data.user.id, body.roomId, body.text)
    this.server.to(body.roomId).emit('message', message)
    return { ok: true }
  }
}
```

Register the gateway in a module's `providers` array like any other provider. It is not a `controller`.

| Decorator | Binds |
| --- | --- |
| `@WebSocketGateway(port?, options?)` | the class, with `GatewayMetadata` options |
| `@WebSocketServer()` | a property, to the underlying `Server` or `Namespace` |
| `@SubscribeMessage('name')` | a method, to an inbound event name |
| `@MessageBody()` | a parameter, to the message payload (accepts pipes and a property key) |
| `@ConnectedSocket()` | a parameter, to the client socket |
| `@Ack()` | a parameter, to the Socket.IO acknowledgement callback |

Returning a value from a `@SubscribeMessage()` handler sends it as the acknowledgement. Returning a `WsResponse<T>` — `{ event, data }` — emits a named event back to that client instead. Returning an `Observable` streams every emission back, which is the cheapest way to implement a server-push feed that a single client asked for.

`@Ack()` is the Nest 12 addition: taking the callback as a parameter tells the framework **not** to acknowledge automatically from the return value, so you can acknowledge early, late, or from inside a branch.

```ts title="src/chat/chat.gateway.ts"
import { Ack, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets'

@WebSocketGateway()
export class UploadsGateway {
  @SubscribeMessage('upload')
  async onUpload(@MessageBody() body: { id: string }, @Ack() ack: (response: unknown) => void) {
    ack({ accepted: true })                 // tell the client we took it
    await this.uploads.process(body.id)     // then do the slow part
  }
}
```

## Gateway options worth setting

`GatewayMetadata` is Socket.IO's server options plus `namespace`. Four of them are decisions rather than defaults:

| Option | Default | Why you would change it |
| --- | --- | --- |
| `namespace` | `/` | isolate feature areas; each namespace is its own gateway class |
| `cors` | none | **Socket.IO does its own CORS.** `app.enableCors()` does not cover it |
| `maxHttpBufferSize` | `1e6` (1 MB) | the per-message size cap; lower it to what your largest legitimate message needs |
| `transports` | `['polling', 'websocket']` | `['websocket']` skips the HTTP long-polling fallback, at the cost of old clients |

:::danger
`app.enableCors()` configures the **HTTP** adapter. A gateway's origin check comes from its own `cors` option, so a gateway declared without one accepts a WebSocket handshake from any origin — including a page the attacker controls, which then rides the user's cookies. Set `cors.origin` to an explicit allow-list on every gateway. [CORS](../nestjs-security/cors.md) has the general case, and it applies here with the extra rule that `credentials: true` plus a reflected origin is the same hole it is over HTTP.
:::

`maxHttpBufferSize` is the memory-exhaustion control. A client that can send a 1 MB message can send a thousand of them; the ceiling should be sized to your protocol, not left at the default.

## How guards and pipes differ from HTTP

Guards, interceptors, pipes and exception filters all work in a gateway. The differences are specific and each one has burned somebody:

| | HTTP | Gateway |
| --- | --- | --- |
| Nest middleware | runs | **never runs** — middleware is bound to routes |
| Guard runs | once per request | once per **message** |
| Guard runs on connect | n/a | **no** — `handleConnection()` is outside the pipeline |
| Argument host | `host.switchToHttp()` | `host.switchToWs()` — `getData()`, `getClient()`, `getPattern()` |
| Exception to throw | `HttpException` | `WsException` |
| Failure result | an HTTP status | an `error` event emitted to that client |
| `@Res()` / response object | exists | does not exist |

The two that matter most:

**Middleware does not run.** Anything you rely on middleware for — request ids, a session lookup, a tenant resolver — is simply absent in a gateway. Move it into a guard or an interceptor if both surfaces need it.

**Guards do not protect the connection.** `@UseGuards(WsAuthGuard)` on a `@SubscribeMessage()` handler runs when that message arrives, not when the socket opens. An unauthenticated client can connect, stay connected, consume a file descriptor and join nothing — and if any of your code broadcasts to the namespace rather than to a room, it receives that too. Authenticate at the handshake as well.

```ts title="src/chat/ws-auth.guard.ts"
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { WsException } from '@nestjs/websockets'
import type { Socket } from 'socket.io'

@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const client = context.switchToWs().getClient<Socket>()
    if (!client.data?.user) {
      throw new WsException('Unauthorized')
    }
    return true
  }
}
```

A `WsException` is emitted to the client as `{ status: 'error', message }`. `BaseWsExceptionFilter` also attaches a `cause` describing the message that failed — `{ pattern, data }` — which is controlled by two constructor options: `includeCause` (default `true`) and `causeFactory`.

:::warning
`includeCause` defaults to `true`, so by default the **payload that caused the error is echoed back to the client**. That is useful for correlating a failure with a request and dangerous when the payload contained a credential or when the error came from a pipe that received something it should not have. Override `causeFactory` to return only an id you generated, or construct the filter with `includeCause: false`.
:::

Pipes work normally on `@MessageBody()`, and validating a WebSocket message is not optional — it is an unauthenticated-by-default entry point that bypasses every HTTP control you configured:

```ts
import { UsePipes, ValidationPipe } from '@nestjs/common'
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets'
import { PostMessageDto } from './dto/post-message.dto.js'

@WebSocketGateway()
export class ChatGateway {
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('message')
  onMessage(@MessageBody() body: PostMessageDto) {
    return this.chat.post(body)
  }
}
```

## Authenticating at the handshake

The right place to reject an unauthenticated client is before the connection is established. Socket.IO exposes this as namespace middleware, which you reach from `afterInit()`:

```ts title="src/chat/chat.gateway.ts"
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets'
import { JwtService } from '@nestjs/jwt'
import type { Namespace, Socket } from 'socket.io'

@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway implements OnGatewayInit {
  private readonly jwt: JwtService

  constructor(jwt: JwtService) {
    this.jwt = jwt
  }

  afterInit(namespace: Namespace) {
    namespace.use(async (socket: Socket, next: (err?: Error) => void) => {
      try {
        const token = socket.handshake.auth?.token
        socket.data.user = await this.jwt.verifyAsync(token)
        next()
      } catch {
        next(new Error('Unauthorized'))
      }
    })
  }
}
```

Three things this gets right that the common version does not:

- **The token comes from `handshake.auth`, not a header.** A browser cannot set arbitrary headers on a WebSocket, so `Authorization` is not available to you. `auth` is the Socket.IO channel for it, and unlike `handshake.query` it does not end up in access logs or a `Referer`.
- **`next(err)` rejects the connection** before any handler is reachable, which is what makes the file-descriptor and broadcast problems above go away.
- **The verified identity lands on `socket.data`**, where guards and handlers read it for the life of the connection.

:::warning
A connection outlives the token that opened it. A socket authenticated with a token that expires in fifteen minutes will still be connected two hours later, because nothing re-checks. If you need revocation — a logout, a ban, a role change — you must either expire connections on a timer or check an authorization store on the messages that matter. See [JWT pitfalls](../nestjs-security/jwt-pitfalls.md).
:::

## Rooms

A room is a server-side label on a set of sockets. It is Socket.IO's only real fan-out primitive, and using it correctly is the difference between "the right people see this" and "everybody sees this".

```ts title="src/chat/chat.gateway.ts"
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'

@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway {
  @WebSocketServer()
  server: Server

  @SubscribeMessage('join')
  async onJoin(@MessageBody() body: { roomId: string }, @ConnectedSocket() client: Socket) {
    // Authorize the join. Never let a client name the room it joins unchecked.
    await this.chat.assertMember(client.data.user.id, body.roomId)
    await client.join(body.roomId)
    return { joined: body.roomId }
  }

  broadcast(roomId: string, message: unknown) {
    this.server.to(roomId).emit('message', message)
  }
}
```

:::danger
`client.join(body.roomId)` with an unchecked `roomId` is the WebSocket form of [IDOR](../nestjs-security/authorization-and-idor.md): the client picks a room name, joins it, and receives everything broadcast there. Authorize the join against the user's actual membership, exactly as you would authorize `GET /rooms/:id`. Every socket is also auto-joined to a room named after its own id, which is the correct way to address one client: `server.to(socket.id).emit(...)`.
:::

`server.emit()` with no `.to()` goes to **every** socket in the namespace. That is almost never what you want outside a system-wide announcement.

## Scaling across instances

This is the thing that works on your laptop and fails the first time you run two replicas.

Socket.IO's default adapter is in-memory. Each Node process knows only about its own sockets, so `server.to(roomId).emit(...)` on instance A reaches nobody connected to instance B. With three replicas, roughly two-thirds of your users miss every message.

The fix is a shared adapter. Extend `IoAdapter` and hand the Socket.IO server a Redis-backed one:

```bash
npm install @socket.io/redis-adapter@8 redis@6
```

```ts title="src/ws/redis-io.adapter.ts"
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { ServerOptions } from 'socket.io'

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>

  async connectToRedis(url: string): Promise<void> {
    const pubClient = createClient({ url })
    const subClient = pubClient.duplicate()
    await Promise.all([pubClient.connect(), subClient.connect()])
    this.adapterConstructor = createAdapter(pubClient, subClient)
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options)
    server.adapter(this.adapterConstructor)
    return server
  }
}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { RedisIoAdapter } from './ws/redis-io.adapter.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  const redisIoAdapter = new RedisIoAdapter(app)
  await redisIoAdapter.connectToRedis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  app.useWebSocketAdapter(redisIoAdapter)

  await app.listen(3000)
}

bootstrap()
```

Two separate Redis connections are required because a client in subscriber mode cannot issue other commands — `duplicate()` is not an optimization.

Three more things a multi-instance gateway needs:

- **Sticky sessions**, unless you set `transports: ['websocket']`. The HTTP long-polling handshake takes several requests, and they must all reach the same process. Configure session affinity on the load balancer or turn polling off.
- **A connection budget.** Each socket is an open file descriptor and a slice of memory for its lifetime, which is unbounded. Cap it, and monitor it — see [Clustering](../nestjs-production/clustering.md).
- **Shutdown that closes sockets.** A rolling deploy that drops connections without a close frame leaves clients reconnecting in a thundering herd. [Graceful shutdown](../nestjs-production/graceful-shutdown.md) covers the general case.

:::note
Nest's `AbstractWsAdapter` is the seam, so a native `ws` server or another implementation drops in through `app.useWebSocketAdapter()` and every gateway keeps working. That is what makes the decorators worth using even if you later leave Socket.IO.
:::

## When not to reach for WebSockets

A WebSocket is a stateful, bidirectional connection. If your data only flows server-to-client — notifications, progress, a live counter, a log tail — you are paying for the return channel, the reconnect logic, the sticky sessions and the shared adapter and using none of it.

[Server-sent events](server-sent-events.md) is one decorator, rides plain HTTP, reconnects on its own, and needs no adapter. Choose WebSockets when the client genuinely sends messages back at a rate that would be wasteful as requests.

## Common mistakes

- **Assuming `app.enableCors()` covers the gateway.** It does not. Socket.IO does its own origin check; set `cors` on the gateway.
- **Expecting Nest middleware to run.** Middleware is bound to routes. A gateway never sees it.
- **Guarding only the message handlers.** Guards run per message, not on connect. Authenticate in namespace middleware at the handshake too.
- **Reading the token from a header.** Browsers cannot set headers on a WebSocket. Use `handshake.auth`; avoid `handshake.query`, which lands in logs.
- **Throwing `HttpException` in a gateway.** There is no response to put a status on. Use `WsException`.
- **Leaving `includeCause` at its default when payloads are sensitive.** The failing message is echoed back to the client.
- **`client.join()` on a client-supplied room id without an authorization check.** The client picks what it receives. That is IDOR.
- **`server.emit()` when you meant `server.to(room).emit()`.** The first goes to the whole namespace.
- **Running more than one replica with the in-memory adapter.** Messages reach only the instance that published them. Use the Redis adapter.
- **Polling transport without sticky sessions.** The handshake spans several HTTP requests and they must land on one process.
- **Leaving `maxHttpBufferSize` at 1 MB.** It is a memory-exhaustion ceiling; size it to your protocol.
- **Not validating `@MessageBody()`.** It is an entry point that skipped every HTTP control you configured.
- **Using a WebSocket for one-way push.** SSE is one decorator and reconnects itself.

## Related topics

- [Server-sent events](server-sent-events.md) — the one-way alternative, and usually the right one.
- [Guards](../nestjs-request-handling/guards.md) — the class `switchToWs()` changes the shape of.
- [Pipes](../nestjs-request-handling/pipes.md) — validating `@MessageBody()` the way you validate a body.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — the HTTP counterpart of `BaseWsExceptionFilter`.
- [CORS](../nestjs-security/cors.md) — why the gateway needs its own origin allow-list.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the room-join check, in its general form.
- [JWT pitfalls](../nestjs-security/jwt-pitfalls.md) — a token that outlives the connection it opened.
- [Redis](../nestjs-databases/redis.md) — the connection the adapter needs, configured properly.
- [Clustering](../nestjs-production/clustering.md) — connection budgets and sticky sessions.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — closing sockets instead of dropping them.
- [GraphQL](graphql.md) — subscriptions, which have the identical multi-instance fan-out problem.
- [Microservices and transports](microservices.md) — moving the fan-out to a broker instead of an adapter.
