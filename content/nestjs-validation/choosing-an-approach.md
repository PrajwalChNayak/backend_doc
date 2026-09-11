---
title: Choosing an approach
description: A balanced comparison of class-validator and Standard Schema in NestJS 12 — ergonomics, type-inference direction, runtime cost, Swagger, refactoring safety, and when each is the wrong choice.
status: current
updated: 2026-09-11
---

NestJS 12 ships two validation stacks, and neither is deprecated. The classic one runs `class-validator` 0.15.1 over a decorated DTO class; the new one runs any Standard Schema — Zod, Valibot, ArkType — attached to the parameter. This page is the argument about which to use, and it ends with an actual recommendation rather than "it depends".

If you have not read the two mechanically, start with [The ValidationPipe](validation-pipe.md) and [Standard Schema with Zod](standard-schema-with-zod.md). This page assumes you know what each looks like.

## The same contract, twice

```ts title="class-validator"
import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName: string

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(150)
  age?: number
}
```

```ts title="Zod 4"
import { z } from 'zod'

export const createUserSchema = z.strictObject({
  email: z.email(),
  displayName: z.string().min(1).max(80),
  age: z.int().min(13).max(150).optional(),
})

export type CreateUser = z.infer<typeof createUserSchema>
```

Both reject the same requests. The differences are everywhere except the happy path.

## The comparison

| Dimension | class-validator + `ValidationPipe` | Standard Schema + `StandardSchemaValidationPipe` |
| --- | --- | --- |
| **Shape** | A class whose properties carry decorators | A value you import |
| **Type-inference direction** | Class first — the TypeScript type is the source, constraints are annotations on it | Schema first — the runtime schema is the source, the type is derived with `z.infer` |
| **Can type and check disagree?** | Yes. `age: string` with `@IsInt()` compiles and fails at runtime | No. The type *is* the schema's output |
| **Build requirements** | `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata` | Nest's own decorators only; no metadata emit |
| **Dependencies** | Two pre-1.0 peers you version yourself | One schema library |
| **Unknown keys** | Pipe-level: `whitelist`, `forbidNonWhitelisted` | Schema-level: `z.strictObject()`, `.onUndeclaredKey('reject')` |
| **Enforcement default** | Global pipe covers every class-typed parameter automatically | Opt-in per parameter; a missing `schema` is silently unvalidated |
| **Conditional and cross-field rules** | Custom validator with `registerDecorator`, or `@ValidateIf` | `.refine()` / `.superRefine()` on the schema |
| **Injecting a provider into a rule** | Supported — a `@ValidatorConstraint` class plus `useContainer()` | Not supported by the pipe; do the lookup in the service |
| **Reuse outside HTTP** | The class validates microservice and queue payloads too | The schema validates anything, including config at boot |
| **OpenAPI** | First-party: `@nestjs/swagger` 12.0.1 reads the decorators | Convert the schema yourself — `z.toJSONSchema()` or a zod-to-OpenAPI package |
| **Transformation** | `class-transformer` via `@Type()`, `@Transform()`, `transformOptions` | Built into the schema: `.transform()`, `.default()`, `z.coerce` |
| **Refactoring safety** | Renaming a property leaves its decorators attached; deleting a decorator is silent | Renaming a key changes the inferred type, so call sites fail to compile |
| **Error shape** | `ValidationError[]` — nested `children`, `constraints` keyed by rule name | Flat `readonly Issue[]` — `message` and `path` |
| **Runtime work per request** | Construct an instance, then look up metadata per property | Run the schema's validator; no instance construction |

### Type-inference direction is the real fork

Everything else follows from this row.

Class-first means you write the TypeScript type and then annotate it. TypeScript is authoritative about shape; the decorators are a *separate* claim about the same fields, and nothing checks that the two agree. `@IsString() age: number` compiles. `@IsEmail()` on a field you later renamed still validates the old name if you forget the decorator. The class stack is a second source of truth that happens to sit on the same lines.

Schema-first inverts it. The schema is the only declaration, and `z.infer` projects it into the type system. You cannot have a constraint that contradicts the type, because the type is generated from the constraint. The cost is that your domain types now come from a library — `CreateUser` is `z.infer<typeof createUserSchema>`, not a hand-written interface you can read at a glance.

:::best-practice
Whichever you pick, never write the type and the validation separately. A hand-written `interface CreateUser` next to a Zod schema is the worst of both: two sources of truth with no link between them.
:::

### Decorator ergonomics

The decorator form genuinely reads well for a wide, flat DTO. The constraint sits on the line it constrains, there is no nesting to track, and a reviewer sees `@MaxLength(80)` next to `displayName` without following a reference.

It gets worse as the shape gets harder. A nested object needs `@ValidateNested()` *and* `@Type()` — two decorators that only work as a pair, where omitting one produces a silent hole rather than an error. An array of objects needs `{ each: true }` in the right places and `@ArrayMaxSize()` in another. A union type has no clean expression at all. Zod's `z.discriminatedUnion()` and Valibot's `v.variant()` handle the last case in one line.

The schema form is uniformly verbose and uniformly capable. There is no shape it handles worse than another.

### Runtime cost

`ValidationPipe` with `transform: true` does more work: `plainToInstance` builds a real object, then `class-validator` looks up the registered metadata for the class and runs each constraint, then — depending on options — the result may be converted back to a plain object. A schema library precomputes its validation plan when the schema is built at module load, and the per-request path is a function call over the plan.

The honest framing is that the schema stack does less work per request, that the difference is small next to a single database round trip, and that neither is your bottleneck until you have measured and found that it is. What *is* worth watching in both stacks is unbounded input: a 10,000-element array validated element-wise is expensive regardless of which library does it, which is why `@ArrayMaxSize()` and `.max()` are not optional.

### Ecosystem, and why Swagger pulls toward classes

This is the strongest practical argument for the classic stack. `@nestjs/swagger` 12.0.1 builds the OpenAPI document from class metadata: `@ApiProperty()`, plus its CLI plugin that infers most of it from the DTO's types and `class-validator` decorators. `PartialType`, `PickType` and `OmitType` have `@nestjs/swagger` versions that carry the OpenAPI metadata along with the validation metadata. In a class-first project, accurate API documentation is close to free.

None of that sees a Standard Schema. You get there by a different road: Zod 4 ships `z.toJSONSchema()`, and `@asteasolutions/zod-to-openapi` 9.1.0 or `zod-openapi` 6.0.2 produce a complete document from the same schemas that validate. That road works and has the advantage that the document is generated from the thing that actually runs — but it is wiring you assemble rather than a plugin you enable. Budget for it.

The rest of the ecosystem is closer to even. `@nestjs/config` 12.0.0 accepts any Standard Schema for `validationSchema`, so environment validation is schema-first regardless of what your DTOs look like.

### Refactoring safety

Rename `displayName` to `name` in the class. The decorators move with the property because they are attached to it — that part is fine. Now delete `@IsString()` by accident during a merge: the property becomes invisible to `class-validator`, `whitelist: true` strips it, and the field silently stops arriving. No test fails unless one specifically asserts that field's presence.

Rename a key in a Zod schema and every consumer of `z.infer` fails to compile. Delete a field and the same thing happens. The compiler is on your side because the runtime artifact and the type are the same artifact.

This is the argument that usually decides it for large, long-lived codebases.

### Mixing the two

You can run both pipes globally, and they do not collide:

```ts title="src/main.ts"
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  new StandardSchemaValidationPipe(),
)
```

`StandardSchemaValidationPipe` skips any parameter with no `schema` in its metadata. `ValidationPipe` skips any parameter whose metatype is `Object` — which is what a `z.infer` type alias erases to. Each ignores the other's parameters, so a class-DTO route and a schema route can sit in the same controller.

That is genuinely useful as a migration path, and genuinely bad as a permanent state. Two stacks means two error shapes to normalize, two sets of rules a reviewer has to know, and two ways for a new route to be unprotected. If you mix, mix on purpose and with a deadline.

## The recommendation

**For a new NestJS service, use the Standard Schema stack with Zod 4.** The schema is a value you can reuse for config, queue payloads and OpenAPI generation; the type cannot drift from the check; there is no metadata-emit build fragility; and the dependency is a 4.x library rather than two 0.x ones.

**Stay on class-validator when the project is already there, or when `@nestjs/swagger` is load-bearing.** Rewriting working DTOs buys nothing. And if your API document is generated by the Swagger CLI plugin today and consumed by client codegen, moving to schemas means rebuilding that pipeline — which is real work for a benefit that is mostly stylistic.

**Do not split a codebase in half on preference.** One stack per service. A mixed codebase is a migration, not an architecture.

### When class-validator is the wrong choice

- You are validating something that is not a class-shaped payload — a discriminated union, a tuple, a recursive tree. The decorator form fights you.
- Your build is SWC, esbuild or a bundler where decorator-metadata emission is a configuration you might lose. The failure mode is validation that passes everything, not a build error.
- You want the same contract enforced in a browser client. Shipping `class-validator` plus `reflect-metadata` to the front end for that is a poor trade; a schema is a plain value that runs anywhere.
- You cannot tolerate a pre-1.0 dependency in your supply chain for policy reasons.

### When Standard Schema is the wrong choice

- Your OpenAPI document is produced by the `@nestjs/swagger` CLI plugin and consumed by generated clients. You would be replacing a working pipeline with one you maintain.
- A validation rule genuinely needs an injected provider. `class-validator` supports that through a constraint class and `useContainer()`; the schema pipe has no DI story, and the honest answer is to move the check into the service — which is often better anyway, because a database-backed "is this email free" check is not authoritative under concurrency.
- Your team reads DTO classes as domain documentation and the codebase is organized around them. `z.infer` types are correct and less readable at a glance.
- You reuse one DTO class across HTTP, microservice and queue transports with `@nestjs/mapped-types` composition. That composition story is more mature on the class side.

## Security considerations

**Both stacks are capable of the same protection. Neither provides it by default.**

The classic pipe validates every parameter with a class metatype, but it strips nothing until you set `whitelist: true` and rejects nothing until you add `forbidNonWhitelisted: true`. The schema pipe rejects unknown keys the moment you write `z.strictObject()`, but it validates *nothing* on a parameter where you forgot the `schema`. The two failure modes are opposites:

| Stack | The way it silently fails open |
| --- | --- |
| class-validator | The pipe runs, but `whitelist` is off — unknown keys flow through validated payloads |
| class-validator | A property has no decorator, so it is invisible to validation and to the whitelist |
| Standard Schema | A parameter has no `schema`, so the pipe passes it through untouched |
| Standard Schema | `z.object()` instead of `z.strictObject()` — unknown keys are dropped silently rather than reported |

Both are caught by the same test, and only by that test: post an unexpected privileged field to every write route and assert a 400. Reading the configuration is not verification. See [Whitelisting and unknown properties](unknown-properties.md) and [Validation as a security control](../nestjs-security/validation-as-a-control.md).

**Both pipes strip prototype-pollution keys.** `ValidationPipe` and `StandardSchemaValidationPipe` each run a `stripProtoKeys` pass that deletes `__proto__`, `prototype` and `constructor` from the incoming value before validating. That parity means the choice between them is not a security decision on that axis.

**Neither is authorization, and neither is output encoding.** A structurally valid request from the wrong user is still an IDOR, and a valid string can still contain `<script>`.

## Common mistakes

- **Treating the choice as urgent.** Both stacks are supported in 12.x. An existing class-validator codebase is not technical debt.
- **Mixing both in one service with no plan to converge.** Two error shapes, two review checklists, two ways to leave a route open.
- **Writing a hand-rolled interface next to a Zod schema.** Use `z.infer`; a parallel type is a second source of truth that nothing keeps honest.
- **Switching to schemas and discovering Swagger afterward.** Check what consumes your OpenAPI document *before* you migrate.
- **Assuming the schema stack is faster in a way that matters.** It does less work per request; your database does more. Measure.
- **Porting DTOs one at a time with no global pipe covering the gap.** During a migration, keep both pipes registered so nothing is unprotected mid-flight.
- **Choosing class-validator for a union or recursive payload.** It is the shape the decorator form handles worst.
- **Expecting dependency injection inside a Zod `.refine()`.** There is none; put the lookup in the service.
- **Believing either default is safe.** `whitelist: false` and a missing `schema` both fail open.

## Related topics

- [The ValidationPipe](validation-pipe.md) — the classic pipe, its options, and where to bind it.
- [class-validator and class-transformer](class-validator.md) — the decorator stack in depth.
- [Standard Schema with Zod](standard-schema-with-zod.md) — the schema stack in depth.
- [Whitelisting and unknown properties](unknown-properties.md) — the one control both stacks must get right.
- [Transforming payloads](transforming-payloads.md) — how each stack coerces and reshapes input.
- [Serialization](serialization.md) — the same two-stack split on the response side.
- [DTOs](../nestjs-request-handling/dtos.md) — structuring the classes the classic stack validates.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — the ecosystem argument, in detail.
- [Validation](../express-libraries/validation.md) — the Zod 4 API itself, outside Nest.
- [The comparison](../express-vs-nestjs/comparison.md) — the wider "what does Nest add" question.
