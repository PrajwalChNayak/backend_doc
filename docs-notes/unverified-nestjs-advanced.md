# Unverified / omitted — Advanced NestJS section

Authoring pass: 2026-09-11. Section: `content/nestjs-advanced/` (9 pages).

Method: every package in this section was fetched with `npm pack` and its published
`.d.ts` / `.js` read directly. Anything below was **left out of the pages** because it
could not be verified that way, or because the verified answer contradicts the common
tutorial advice and the correct wording needs a decision from the coordinator.

---

## Left out — could not verify against a `.d.ts` or official docs

| Item | Why it was omitted |
| --- | --- |
| JetStream support in `@nestjs/microservices` | `@nats-io/transport-node@3.4.0` ships JetStream through the separate `@nats-io/jetstream` package. Nothing in `@nestjs/microservices@12.0.1`'s `client-nats.js` / `server-nats.js` references JetStream — it uses core `publish`/`subscribe`/`request` only. No verifiable Nest-level JetStream API, so the pages say nothing about it. |
| `Transport.GRPC` health-checking / reflection | `GrpcOptions` has no option for either. Usually done with extra `@grpc/*` packages wired outside Nest. Omitted rather than guessed. |
| Kafka consumer group / `postfixId` guidance beyond the type | `postfixId` is real (`"-server"` on the server, `"-client"` on the client), but the operational advice around consumer-group naming is not in the types. Only the verified default is stated. |
| `@nestjs/graphql` schema-first `definitions` watch mode | `definitions: { path, outputAs }` is verified; `DefinitionsGeneratorOptions` is re-exported from `graphql-ast.explorer` and its fields were not individually verified. Only `path` and `outputAs` appear in the page. |
| GraphQL federation (`ApolloFederationDriver`, `ApolloGatewayDriver`) | Both drivers exist in `@nestjs/apollo@14.0.0`, with peers `@apollo/subgraph` 2.15.0 / `@apollo/gateway` 2.14.4. Federation is a section-sized topic and was not covered; the page names the drivers as existing and stops there. |
| Mercurius driver (`@nestjs/mercurius`) | Not in the verified version table in CONTRIBUTING Part 2, so it is not named as a supported option anywhere. |
| `graphql-depth-limit` as a recommendation | Real package, but `1.1.0` and last published **2022-05-04**. It is mentioned only as stale; the page teaches query complexity with `graphql-query-complexity@2.0.0`, which is verified against the Nest docs plugin example. |
| Fastify + `FileInterceptor` | `@nestjs/platform-fastify@12.0.1` contains **no** multipart or file-interceptor code (`grep` for `multipart`/`FileInterceptor` returns nothing); `FileInterceptor` lives in `@nestjs/platform-express`'s `multer/` directory and is multer-based. The page states that and points at `@fastify/multipart` (10.1.1) as the plugin, without inventing a Nest-level API on top of it. |
| A benchmark number for Fastify vs Express | Deliberately omitted per the brief. No reproducible measurement was taken, so no figure is quoted. |
| `nest deploy` details | The command exists in `@nestjs/cli@12.0.0` (`commands/deploy.command.js`), but its behavior depends on an external service. Named only; no flags documented. |

---

## Verified facts that contradict common tutorials — flagged for the coordinator

1. **`@apollo/server@5.5.1` still declares `peerDependencies: { graphql: "^16.11.0" }`.**
   `@nestjs/graphql@14.0.0` accepts `^16.11.0 || ^17.0.0`, and `graphql`'s npm `latest`
   is `17.0.2` — but installing `graphql@17` alongside the Apollo driver produces a peer
   conflict. `graphql` dist-tag `latest-16` is `16.14.2`. The GraphQL page documents
   `graphql@16.14.2` for the Apollo driver and explains why, rather than repeating the
   `17.0.2` from the supporting-package list as if it worked. **If CONTRIBUTING §11.1's
   `graphql 17.0.2` line is meant to be the number used in install commands, this needs a
   correction there too.**

2. **`includeLibraryAssets` is `string[]`, not `boolean`.**
   From `@nestjs/cli@12.0.0` `lib/configuration/configuration.d.ts`:
   `includeLibraryAssets?: string[]` — "List of library project names whose assets should
   also be copied when building this application." `build.action.js` also warns at build
   time when a library declares `compilerOptions.assets` and no app opted into it.

3. **The v12 monorepo default builder is `rspack`, not `webpack`.**
   `@nestjs/schematics@12.0.0` `sub-app.factory.js` sets
   `optionsFile.compilerOptions.builder = 'rspack'` when converting a standard project to
   a monorepo, and `library.factory.js` sets it when it is `undefined`.

4. **`FastifyAdapter.isRouteOrderSensitive()` returns `false`.**
   `nest-application.js` reads `this.httpAdapter.isRouteOrderSensitive?.() ?? true`, so the
   Express adapter is order-sensitive and Fastify is not. This means
   `routeResolutionStrategy: 'specificity'` (documented on
   `nestjs/routing-and-path-syntax.md`) is a no-op under Fastify. Worth a line in the
   routing page on the next pass.

5. **`@nestjs/platform-fastify@12.0.1` bundles `path-to-regexp@8.4.2` as well.**
   It is used only by the bundled middie shim for **middleware** path matching
   (`adapters/middie/fastify-middie.js` calls `pathToRegexp(normalizedPath)`); routes
   themselves go to Fastify's `find-my-way@9.9.0`. So middleware paths and route paths use
   two different matchers under Fastify. The page says this.

6. **Two Nest 12 decorators that no tutorial covers yet, both verified in the shipped source:**
   - `@SseSignal()` + the `SSE_ABORT_CONTROLLER` symbol in `@nestjs/common@12.0.1`
     (`decorators/http/sse-signal.decorator.js`) — injects the per-request `AbortSignal`
     for an SSE stream. Documented on `server-sent-events.md`.
   - `@Ack()` in `@nestjs/websockets@12.0.1` (`decorators/ack.decorator.d.ts`) — takes over
     the Socket.IO acknowledgement callback manually. Documented on `websockets.md`.

7. **`@nestjs/cqrs@12.0.0` ships `Command<T>` / `Query<T>` base classes** with a
   `RESULT_TYPE_SYMBOL` phantom field, which makes `commandBus.execute()` infer its result
   type. The older `ICommand` / `IQuery` marker interfaces still work and still return
   `any`. The page teaches the typed base classes.
