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

export const sections = [
  {
    id: 'getting-started',
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
]

/**
 * Pages that are exempt from the "no Express 4 API" rule in scripts/check.mjs,
 * because documenting the old API *is* their job.
 */
export const legacyExemptPages = [
  'reference/express-4-to-5-migration',
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

/** Look up a page by `${sectionId}/${slug}`. */
export function findPage(path) {
  return flatten().find((p) => p.path === path)
}

export default { site, sections, flatten, findPage, legacyExemptPages }
