/**
 * nav.mjs — the single source of truth for the site's information architecture.
 *
 * Everything downstream reads this file:
 *   - the top navigation bar and its per-section dropdowns
 *   - previous / next links (flattened order)
 *   - breadcrumbs (section title)
 *   - the search index build order
 *   - scripts/check.mjs orphan + missing-file detection
 *
 * EXTENDING THE SITE (e.g. the Next.js pass):
 *   Append a new object to `sections`. Nothing else has to change — the generator,
 *   the checker and the templates all derive from this array. Keep `id` stable
 *   because it becomes the content directory name and the URL segment.
 *
 * Shape:
 *   {
 *     id: 'express',                  // content/<id>/ and docs/<id>/
 *     group: 'core',                  // which platform bar this belongs to
 *     title: 'Express Fundamentals',  // full name: breadcrumb, section index, <title>
 *     navLabel: 'Express',            // short label for the top navigation bar
 *     summary: '…',                   // section index page blurb
 *     pages: [ { slug, title } ]      // slug = <slug>.md / <slug>.html
 *   }
 */

export const site = {
  title: 'Node.js & Express Backend Handbook',
  shortTitle: 'Backend Handbook',
  description:
    'A production-grade reference for building backends with Node.js 24 LTS and Express 5 — fundamentals, libraries, databases, ORMs, security and operations.',
  // Set at build time into every page as a data attribute; used by the footer.
  verified: '2026-09-08',
  repo: 'https://github.com/PrajwalChNayak/backend_doc',
}

/**
 * Top-level platform groups. The navigation bar shows the sections of the
 * group you are currently reading, plus a switcher to the others — which is
 * what keeps the bar readable now that there are twenty-one sections.
 *
 * Adding a third platform is: append a group here, append its sections below
 * with a matching `group`, and create the content directories.
 */
export const groups = [
  {
    id: 'core',
    label: 'Node & Express',
    summary: 'The runtime and the framework it is usually served with.',
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    summary: 'The opinionated framework on top of Express 5, and everything around it.',
  },
]

export const sections = [
  {
    id: 'getting-started',
    group: 'core',
    navLabel: 'Start',
    title: 'Getting Started',
    summary: 'What this handbook is, who it is for, and how to run everything in it.',
    pages: [
      { slug: 'introduction', title: 'Introduction' },
      { slug: 'what-this-covers', title: 'What this covers' },
      { slug: 'prerequisites', title: 'Prerequisites' },
      { slug: 'running-the-examples', title: 'Running the examples' },
    ],
  },
  {
    id: 'node',
    group: 'core',
    navLabel: 'Node.js',
    title: 'Node.js Fundamentals',
    summary:
      'The runtime itself: how it schedules work, how modules resolve, and which built-ins replace packages you used to install.',
    pages: [
      { slug: 'runtime-and-event-loop', title: 'Runtime and the event loop' },
      { slug: 'esm-vs-commonjs', title: 'ESM vs CommonJS' },
      { slug: 'package-json-and-npm-scripts', title: 'package.json and npm scripts' },
      { slug: 'async-await-and-promises', title: 'Async/await and promises' },
      { slug: 'error-handling', title: 'Error handling' },
      { slug: 'streams-and-buffers', title: 'Streams and buffers' },
      { slug: 'fs-and-path', title: 'Files and paths' },
      { slug: 'the-http-module', title: 'The http module' },
      { slug: 'environment-variables-and-config', title: 'Environment variables and config' },
      { slug: 'built-in-test-runner', title: 'The built-in test runner' },
      { slug: 'debugging', title: 'Debugging' },
      { slug: 'native-typescript-support', title: 'Native TypeScript support' },
    ],
  },
  {
    id: 'express',
    group: 'core',
    navLabel: 'Express',
    title: 'Express Fundamentals',
    summary:
      'Express 5 from the ground up — routing, middleware, the request/response cycle, and how to lay a real application out.',
    pages: [
      { slug: 'setup-and-project-structure', title: 'Setup and project structure' },
      { slug: 'routing', title: 'Routing' },
      { slug: 'route-parameters-and-path-syntax', title: 'Route parameters and path syntax' },
      { slug: 'middleware', title: 'Middleware' },
      { slug: 'request-and-response', title: 'Request and response' },
      { slug: 'error-handling', title: 'Error handling' },
      { slug: 'routers-and-modularity', title: 'Routers and modularity' },
      { slug: 'static-files', title: 'Static files' },
      { slug: 'templating', title: 'Templating' },
      { slug: 'layered-architecture', title: 'Layered architecture' },
    ],
  },
  {
    id: 'express-libraries',
    group: 'core',
    navLabel: 'Libraries',
    title: 'Express Libraries',
    summary:
      'The packages a real API actually needs, each with the current major version, a working configuration, and the failure modes.',
    pages: [
      { slug: 'security-headers-helmet', title: 'Security headers with Helmet' },
      { slug: 'cors', title: 'CORS' },
      { slug: 'rate-limiting', title: 'Rate limiting' },
      { slug: 'validation', title: 'Validation' },
      { slug: 'authentication', title: 'Authentication' },
      { slug: 'password-hashing', title: 'Password hashing' },
      { slug: 'file-uploads', title: 'File uploads' },
      { slug: 'logging', title: 'Logging' },
      { slug: 'compression', title: 'Compression' },
      { slug: 'cookies', title: 'Cookies' },
      { slug: 'api-documentation', title: 'API documentation' },
      { slug: 'testing', title: 'Testing' },
      { slug: 'process-management-and-graceful-shutdown', title: 'Process management' },
    ],
  },
  {
    id: 'databases',
    group: 'core',
    navLabel: 'Databases',
    title: 'Databases',
    summary:
      'Talking to a database directly: drivers, pools, transactions, migrations, and the operational details that decide whether it survives production.',
    pages: [
      { slug: 'choosing-a-database', title: 'Choosing a database' },
      { slug: 'postgresql-with-pg', title: 'PostgreSQL with pg' },
      { slug: 'mysql-with-mysql2', title: 'MySQL with mysql2' },
      { slug: 'sqlite', title: 'SQLite' },
      { slug: 'mongodb', title: 'MongoDB' },
      { slug: 'redis', title: 'Redis' },
      { slug: 'connection-pooling', title: 'Connection pooling' },
      { slug: 'transactions', title: 'Transactions' },
      { slug: 'migrations', title: 'Migrations' },
      { slug: 'seeding', title: 'Seeding' },
      { slug: 'health-checks', title: 'Health checks' },
      { slug: 'retries-and-timeouts', title: 'Retries and timeouts' },
      { slug: 'n-plus-one-queries', title: 'N+1 queries' },
      { slug: 'indexing-basics', title: 'Indexing basics' },
    ],
  },
  {
    id: 'orms',
    group: 'core',
    navLabel: 'ORMs',
    title: 'ORMs and Query Builders',
    summary:
      'Prisma, Drizzle, TypeORM, Sequelize, Mongoose and Knex — what each is actually good at, and how to keep raw-query escape hatches safe.',
    pages: [
      { slug: 'when-to-use-an-orm', title: 'When to use an ORM' },
      { slug: 'prisma', title: 'Prisma' },
      { slug: 'drizzle', title: 'Drizzle' },
      { slug: 'typeorm', title: 'TypeORM' },
      { slug: 'sequelize', title: 'Sequelize' },
      { slug: 'mongoose', title: 'Mongoose' },
      { slug: 'knex', title: 'Knex' },
      { slug: 'comparison', title: 'Comparison table' },
      { slug: 'migration-strategy', title: 'Migration strategy' },
      { slug: 'testing-with-a-database', title: 'Testing with a database' },
    ],
  },
  {
    id: 'security',
    group: 'core',
    navLabel: 'Security',
    title: 'Security',
    summary:
      'Every page here states the threat, shows a working exploit, gives the fix in code, and tells you how to verify the fix.',
    pages: [
      { slug: 'owasp-api-top-10', title: 'OWASP API Top 10 in Express' },
      { slug: 'sql-injection', title: 'SQL injection' },
      { slug: 'nosql-injection', title: 'NoSQL injection' },
      { slug: 'xss', title: 'Cross-site scripting (XSS)' },
      { slug: 'csrf', title: 'CSRF' },
      { slug: 'authentication-and-session-security', title: 'Authentication and session security' },
      { slug: 'jwt-pitfalls', title: 'JWT pitfalls' },
      { slug: 'secrets-management', title: 'Secrets management' },
      { slug: 'cors-misconfiguration', title: 'CORS misconfiguration' },
      { slug: 'rate-limiting-and-abuse', title: 'Rate limiting and abuse' },
      { slug: 'mass-assignment', title: 'Mass assignment' },
      { slug: 'broken-object-level-authorization', title: 'IDOR and broken object-level authorization' },
      { slug: 'file-upload-security', title: 'File upload security' },
      { slug: 'dependency-auditing', title: 'Dependency auditing' },
      { slug: 'security-headers', title: 'Security headers' },
      { slug: 'https-and-tls', title: 'HTTPS and TLS' },
      { slug: 'logging-without-leaking-pii', title: 'Logging without leaking PII' },
    ],
  },
  {
    id: 'production',
    group: 'core',
    navLabel: 'Production',
    title: 'Production',
    summary: 'Getting it deployed, observable, and survivable.',
    pages: [
      { slug: 'configuration', title: 'Configuration' },
      { slug: 'graceful-shutdown', title: 'Graceful shutdown' },
      { slug: 'clustering', title: 'Clustering' },
      { slug: 'health-and-readiness-probes', title: 'Health and readiness probes' },
      { slug: 'observability', title: 'Observability' },
      { slug: 'dockerfile', title: 'Dockerfile' },
      { slug: 'ci', title: 'Continuous integration' },
      { slug: 'performance', title: 'Performance' },
      { slug: 'deployment-checklist', title: 'Deployment checklist' },
    ],
  },
  {
    id: 'reference',
    group: 'core',
    navLabel: 'Reference',
    title: 'Reference',
    summary: 'Lookup material: the Express 4 → 5 migration, a cheat sheet, and the library index.',
    pages: [
      { slug: 'express-4-to-5-migration', title: 'Express 4 → 5 migration' },
      { slug: 'cheat-sheet', title: 'Cheat sheet' },
      { slug: 'library-index', title: 'Library index' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
  {
    id: 'nestjs',
    group: 'nestjs',
    navLabel: 'Fundamentals',
    title: 'NestJS Fundamentals',
    summary:
      'The architecture: modules, providers, dependency injection, the request lifecycle, and how Nest sits on top of Express 5.',
    pages: [
      { slug: 'introduction', title: 'Introduction and when to choose Nest' },
      { slug: 'installation-and-cli', title: 'Installation and the CLI' },
      { slug: 'project-structure', title: 'Project structure' },
      { slug: 'modules', title: 'Modules' },
      { slug: 'controllers', title: 'Controllers' },
      { slug: 'providers-and-services', title: 'Providers and services' },
      { slug: 'dependency-injection', title: 'Dependency injection' },
      { slug: 'injection-scopes', title: 'Injection scopes' },
      { slug: 'request-lifecycle', title: 'The request lifecycle' },
      { slug: 'routing-and-path-syntax', title: 'Routing and path syntax' },
      { slug: 'configuration', title: 'Configuration' },
      { slug: 'esm-vs-commonjs', title: 'ESM vs CommonJS' },
    ],
  },
  {
    id: 'nestjs-request-handling',
    group: 'nestjs',
    navLabel: 'Requests',
    title: 'NestJS Request Handling',
    summary:
      'Everything the request passes through: middleware, guards, interceptors, pipes, filters and the decorators that read it.',
    pages: [
      { slug: 'middleware', title: 'Middleware' },
      { slug: 'guards', title: 'Guards' },
      { slug: 'interceptors', title: 'Interceptors' },
      { slug: 'pipes', title: 'Pipes' },
      { slug: 'exception-filters', title: 'Exception filters' },
      { slug: 'custom-decorators', title: 'Custom decorators' },
      { slug: 'dtos', title: 'DTOs' },
      { slug: 'versioning', title: 'Versioning' },
      { slug: 'file-uploads', title: 'File uploads' },
    ],
  },
  {
    id: 'nestjs-validation',
    group: 'nestjs',
    navLabel: 'Validation',
    title: 'Validation and Serialization',
    summary:
      'Two validation stacks — class-validator and Standard Schema with Zod — when to use each, and how to shape responses safely.',
    pages: [
      { slug: 'validation-pipe', title: 'The ValidationPipe' },
      { slug: 'class-validator', title: 'class-validator and class-transformer' },
      { slug: 'standard-schema-with-zod', title: 'Standard Schema with Zod' },
      { slug: 'choosing-an-approach', title: 'Choosing an approach' },
      { slug: 'unknown-properties', title: 'Whitelisting and unknown properties' },
      { slug: 'transforming-payloads', title: 'Transforming payloads' },
      { slug: 'serialization', title: 'Serialization' },
    ],
  },
  {
    id: 'nestjs-databases',
    group: 'nestjs',
    navLabel: 'Databases',
    title: 'NestJS Databases',
    summary:
      'Connections inside the DI container, transactions across services, migrations in a deploy pipeline, and health checks.',
    pages: [
      { slug: 'connections-and-di', title: 'Connections and DI' },
      { slug: 'postgresql', title: 'PostgreSQL' },
      { slug: 'mysql', title: 'MySQL' },
      { slug: 'sqlite', title: 'SQLite' },
      { slug: 'mongodb', title: 'MongoDB' },
      { slug: 'redis', title: 'Redis' },
      { slug: 'connection-pooling', title: 'Connection pooling' },
      { slug: 'transactions', title: 'Transactions' },
      { slug: 'migrations', title: 'Migrations' },
      { slug: 'seeding', title: 'Seeding' },
      { slug: 'health-checks', title: 'Health checks' },
      { slug: 'retries-and-timeouts', title: 'Retries and timeouts' },
      { slug: 'testing-with-a-database', title: 'Testing with a database' },
    ],
  },
  {
    id: 'nestjs-orms',
    group: 'nestjs',
    navLabel: 'ORMs',
    title: 'NestJS ORMs',
    summary:
      'TypeORM, Prisma, Mongoose and Drizzle inside Nest — the integration modules, the patterns, and when a raw driver is better.',
    pages: [
      { slug: 'choosing-an-orm', title: 'Choosing an ORM' },
      { slug: 'typeorm', title: 'TypeORM' },
      { slug: 'prisma', title: 'Prisma' },
      { slug: 'mongoose', title: 'Mongoose' },
      { slug: 'drizzle', title: 'Drizzle' },
      { slug: 'raw-drivers', title: 'Raw drivers' },
      { slug: 'comparison', title: 'Comparison table' },
      { slug: 'repository-vs-active-record', title: 'Repository vs active record' },
      { slug: 'avoiding-n-plus-one', title: 'Avoiding N+1' },
    ],
  },
  {
    id: 'nestjs-libraries',
    group: 'nestjs',
    navLabel: 'Libraries',
    title: 'NestJS Libraries',
    summary:
      'The first-party packages a real Nest API uses, each with the current major version and a working configuration.',
    pages: [
      { slug: 'authentication', title: 'Authentication' },
      { slug: 'authorization', title: 'Authorization' },
      { slug: 'throttler', title: 'Rate limiting with Throttler' },
      { slug: 'swagger', title: 'OpenAPI with Swagger' },
      { slug: 'terminus', title: 'Health checks with Terminus' },
      { slug: 'schedule', title: 'Scheduling' },
      { slug: 'bullmq', title: 'Background jobs with BullMQ' },
      { slug: 'cache-manager', title: 'Caching' },
      { slug: 'event-emitter', title: 'Events' },
      { slug: 'logging', title: 'Logging' },
      { slug: 'observe', title: 'Observability with @nestjs/observe' },
    ],
  },
  {
    id: 'nestjs-advanced',
    group: 'nestjs',
    navLabel: 'Advanced',
    title: 'Advanced NestJS',
    summary:
      'Microservices, GraphQL, CQRS, WebSockets, dynamic modules, the Fastify adapter and monorepo layout.',
    pages: [
      { slug: 'microservices', title: 'Microservices and transports' },
      { slug: 'graphql', title: 'GraphQL' },
      { slug: 'cqrs', title: 'CQRS' },
      { slug: 'websockets', title: 'WebSockets' },
      { slug: 'server-sent-events', title: 'Server-sent events' },
      { slug: 'dynamic-modules', title: 'Dynamic modules' },
      { slug: 'lazy-loaded-modules', title: 'Lazy-loaded modules' },
      { slug: 'fastify-adapter', title: 'The Fastify adapter' },
      { slug: 'monorepo-and-libraries', title: 'Monorepo and library mode' },
    ],
  },
  {
    id: 'nestjs-security',
    group: 'nestjs',
    navLabel: 'Security',
    title: 'NestJS Security',
    summary:
      'Threat, exploit, fix and verification for every way a Nest API gets breached — with the framework-specific controls.',
    pages: [
      { slug: 'owasp-api-top-10', title: 'OWASP API Top 10 in Nest' },
      { slug: 'sql-injection', title: 'SQL injection' },
      { slug: 'nosql-injection', title: 'NoSQL injection' },
      { slug: 'validation-as-a-control', title: 'Validation as a security control' },
      { slug: 'authentication-and-session-security', title: 'Authentication and session security' },
      { slug: 'jwt-pitfalls', title: 'JWT pitfalls' },
      { slug: 'authorization-and-idor', title: 'Authorization and IDOR' },
      { slug: 'cors', title: 'CORS' },
      { slug: 'security-headers', title: 'Security headers' },
      { slug: 'rate-limiting', title: 'Rate limiting and abuse' },
      { slug: 'csrf', title: 'CSRF' },
      { slug: 'file-upload-security', title: 'File upload security' },
      { slug: 'secrets-and-config', title: 'Secrets and config validation' },
      { slug: 'dependency-auditing', title: 'Dependency auditing' },
      { slug: 'safe-logging', title: 'Safe logging' },
    ],
  },
  {
    id: 'nestjs-testing',
    group: 'nestjs',
    navLabel: 'Testing',
    title: 'NestJS Testing',
    summary:
      'The testing module, mocking providers, end-to-end tests with supertest, database fixtures and Vitest for ESM projects.',
    pages: [
      { slug: 'unit-tests', title: 'Unit tests' },
      { slug: 'mocking-providers', title: 'Mocking providers' },
      { slug: 'e2e-tests', title: 'End-to-end tests' },
      { slug: 'testing-the-pipeline', title: 'Testing guards, pipes and interceptors' },
      { slug: 'database-fixtures', title: 'Database fixtures' },
      { slug: 'vitest-for-esm', title: 'Vitest for ESM projects' },
      { slug: 'coverage', title: 'Coverage' },
    ],
  },
  {
    id: 'nestjs-production',
    group: 'nestjs',
    navLabel: 'Production',
    title: 'NestJS Production',
    summary:
      'Building, shipping and operating a Nest service: module format, shutdown hooks, probes, Docker, CI and performance.',
    pages: [
      { slug: 'build-and-deployment', title: 'Build and deployment' },
      { slug: 'module-format-in-production', title: 'ESM vs CommonJS in production' },
      { slug: 'configuration', title: 'Environment configuration' },
      { slug: 'graceful-shutdown', title: 'Graceful shutdown' },
      { slug: 'health-and-readiness-probes', title: 'Health and readiness probes' },
      { slug: 'clustering', title: 'Clustering' },
      { slug: 'docker', title: 'Docker' },
      { slug: 'ci', title: 'Continuous integration' },
      { slug: 'performance', title: 'Performance' },
      { slug: 'observability', title: 'Observability' },
      { slug: 'deployment-checklist', title: 'Deployment checklist' },
    ],
  },
  {
    id: 'express-vs-nestjs',
    group: 'nestjs',
    navLabel: 'vs Express',
    title: 'Express vs NestJS',
    summary:
      'An honest comparison: what Nest adds, what it costs, when plain Express wins, and how to migrate incrementally.',
    pages: [
      { slug: 'comparison', title: 'The comparison' },
      { slug: 'when-plain-express-is-better', title: 'When plain Express is better' },
      { slug: 'how-nest-uses-express', title: 'How Nest uses Express' },
      { slug: 'migrating-incrementally', title: 'Migrating incrementally' },
    ],
  },
  {
    id: 'nestjs-reference',
    group: 'nestjs',
    navLabel: 'Reference',
    title: 'NestJS Migration and Reference',
    summary:
      'The v11 to v12 migration, the ESM migration, Express 4 to 5 implications, a decorator reference and troubleshooting.',
    pages: [
      { slug: 'v11-to-v12-migration', title: 'NestJS 11 → 12 migration' },
      { slug: 'esm-migration', title: 'The ESM migration' },
      { slug: 'express-4-to-5-for-nest', title: 'Express 4 → 5 for Nest routes' },
      { slug: 'decorator-reference', title: 'Decorator reference' },
      { slug: 'cheat-sheet', title: 'Cheat sheet' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
]

/**
 * Pages that are exempt from the "no Express 4 API" rule in scripts/check.mjs,
 * because documenting the old API *is* their job.
 */
export const legacyExemptPages = [
  'reference/express-4-to-5-migration',
  'nestjs-reference/v11-to-v12-migration',
  'nestjs-reference/esm-migration',
  'nestjs-reference/express-4-to-5-for-nest',
]

/** Flattened, in sidebar order. Drives prev/next. */
export function flatten() {
  const out = []
  for (const section of sections) {
    for (const page of section.pages) {
      out.push({
        ...page,
        sectionId: section.id,
        sectionTitle: section.title,
        path: `${section.id}/${page.slug}`,
      })
    }
  }
  return out
}

/** Sections belonging to one group, in order. */
export function sectionsInGroup(groupId) {
  return sections.filter((s) => (s.group || 'core') === groupId)
}

/** The group a section id belongs to, defaulting to the first group. */
export function groupOfSection(sectionId) {
  const section = sections.find((s) => s.id === sectionId)
  return (section && section.group) || groups[0].id
}

/** Look up a page by `${sectionId}/${slug}`. */
export function findPage(path) {
  return flatten().find((p) => p.path === path)
}

export default { site, groups, sections, flatten, findPage, legacyExemptPages, sectionsInGroup, groupOfSection }
