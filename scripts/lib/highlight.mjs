/**
 * highlight.mjs — a dependency-free tokenizing syntax highlighter.
 *
 * Real highlighting for the languages this handbook actually uses in anger:
 * js/ts, json, bash, sql. Everything else falls back to escaped plain text
 * rather than mis-colouring it.
 *
 * The approach is a single left-to-right scan with an ordered list of sticky
 * regexes per language. First rule that matches at the cursor wins, so rule
 * order encodes precedence (comments before operators, strings before words).
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c])

const JS_KEYWORDS =
  'await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|get|set'
const TS_KEYWORDS =
  'abstract|as|declare|enum|implements|interface|is|keyof|namespace|never|private|protected|public|readonly|satisfies|type|unknown|any|infer|module|override'
const JS_LITERALS = 'true|false|null|undefined|NaN|Infinity'
const JS_BUILTINS =
  'Array|Boolean|Buffer|Date|Error|TypeError|RangeError|AggregateError|Function|JSON|Map|Math|Number|Object|Promise|Proxy|Reflect|RegExp|Set|String|Symbol|WeakMap|WeakSet|BigInt|URL|URLSearchParams|AbortController|AbortSignal|TextEncoder|TextDecoder|ReadableStream|WritableStream|TransformStream|globalThis|console|process|require|module|exports|__dirname|__filename'

const SQL_KEYWORDS =
  'ADD|ALL|ALTER|AND|ANY|AS|ASC|BEGIN|BETWEEN|BY|CASCADE|CASE|CHECK|COLUMN|COMMIT|CONFLICT|CONSTRAINT|CREATE|CROSS|DATABASE|DECLARE|DEFAULT|DELETE|DESC|DISTINCT|DO|DROP|ELSE|END|EXCEPT|EXECUTE|EXISTS|EXPLAIN|FALSE|FETCH|FOR|FOREIGN|FROM|FULL|GRANT|GROUP|HAVING|IF|ILIKE|IN|INDEX|INNER|INSERT|INTERSECT|INTO|IS|JOIN|KEY|LEFT|LIKE|LIMIT|NATURAL|NOT|NOTHING|NULL|NULLS|OFFSET|ON|ONLY|OR|ORDER|OUTER|OVER|PARTITION|PRAGMA|PRIMARY|PUBLIC|REFERENCES|RENAME|REPLACE|RESTRICT|RETURNING|REVOKE|RIGHT|ROLLBACK|ROW|SAVEPOINT|SCHEMA|SELECT|SET|SHOW|SOME|TABLE|TEMPORARY|THEN|TO|TRANSACTION|TRIGGER|TRUE|TRUNCATE|UNION|UNIQUE|UPDATE|USER|USING|VACUUM|VALUES|VIEW|WHEN|WHERE|WITH'
const SQL_TYPES =
  'BIGINT|BIGSERIAL|BOOLEAN|BYTEA|CHAR|DATE|DECIMAL|DOUBLE|FLOAT|INT|INT4|INT8|INTEGER|INTERVAL|JSON|JSONB|NUMERIC|REAL|SERIAL|SMALLINT|TEXT|TIME|TIMESTAMP|TIMESTAMPTZ|UUID|VARCHAR'
const SQL_FUNCS =
  'ABS|AVG|CAST|COALESCE|CONCAT|COUNT|CURRENT_DATE|CURRENT_TIMESTAMP|DATE_TRUNC|EXTRACT|GREATEST|JSON_AGG|LEAST|LENGTH|LOWER|MAX|MIN|NOW|NULLIF|RANDOM|ROUND|ROW_NUMBER|SUBSTRING|SUM|TRIM|UPPER|UUID_GENERATE_V4|GEN_RANDOM_UUID|PG_SLEEP'

const BASH_BUILTINS =
  'apt|awk|bash|cat|cd|chmod|chown|curl|cut|docker|docker-compose|echo|env|export|find|git|grep|head|kill|ln|ls|make|mkdir|mv|node|npm|npx|openssl|pnpm|printf|ps|psql|pwd|rm|sed|sh|sort|source|sudo|tail|tar|tee|test|touch|uniq|wget|which|xargs|yarn|mysql|redis-cli|mongosh|sqlite3|kubectl|systemctl'

/** Ordered token rules per language. */
const GRAMMARS = {
  js: [
    ['comment', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/y],
    ['string', /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`|'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"/y],
    ['regexp', /(?<=[=(,:[!&|?{};]\s*|^\s*|return\s+)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyvd]*/y],
    ['number', /0[xXbBoO][0-9a-fA-F_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?/y],
    ['literal', new RegExp(`\\b(?:${JS_LITERALS})\\b`, 'y')],
    ['keyword', new RegExp(`\\b(?:${JS_KEYWORDS})\\b`, 'y')],
    ['type', new RegExp(`\\b(?:${TS_KEYWORDS})\\b`, 'y')],
    ['builtin', new RegExp(`\\b(?:${JS_BUILTINS})\\b`, 'y')],
    ['function', /\b[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['property', /(?<=\.)[A-Za-z_$][\w$]*/y],
    ['class', /\b[A-Z][\w$]*/y],
    ['operator', /=>|\.{3}|\?\?=?|\?\.|[+\-*/%!<>=&|^~?:]+/y],
    ['punct', /[{}()[\];,.]/y],
    ['name', /[A-Za-z_$][\w$]*/y],
  ],
  json: [
    ['comment', /\/\/[^\n]*/y],
    ['key', /"(?:\\.|[^"\\])*"(?=\s*:)/y],
    ['string', /"(?:\\.|[^"\\])*"/y],
    ['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
    ['literal', /\b(?:true|false|null)\b/y],
    ['punct', /[{}[\],:]/y],
  ],
  bash: [
    ['comment', /#[^\n]*/y],
    ['string', /'(?:[^'])*'|"(?:\\[\s\S]|[^"\\])*"/y],
    ['variable', /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[@*#?$!0-9]/y],
    ['flag', /(?<=\s)--?[A-Za-z][\w-]*/y],
    ['builtin', new RegExp(`(?:^|(?<=[|;&(]\\s|\\s))(?:${BASH_BUILTINS})\\b`, 'y')],
    ['number', /\b\d+\b/y],
    ['operator', /&&|\|\||>>|<<|[|&<>=;]/y],
    ['punct', /[{}()[\]]/y],
  ],
  sql: [
    ['comment', /--[^\n]*|\/\*[\s\S]*?\*\//y],
    ['string', /'(?:''|[^'])*'/y],
    ['ident', /"(?:""|[^"])*"|`[^`]*`/y],
    ['placeholder', /\$\d+|:[A-Za-z_]\w*|\?/y],
    ['number', /\b\d+(?:\.\d+)?\b/y],
    ['keyword', new RegExp(`\\b(?:${SQL_KEYWORDS})\\b`, 'iy')],
    ['type', new RegExp(`\\b(?:${SQL_TYPES})\\b`, 'iy')],
    ['function', new RegExp(`\\b(?:${SQL_FUNCS})\\b`, 'iy')],
    ['operator', /[+\-*/%<>=!|]+/y],
    ['punct', /[(),.;]/y],
    ['name', /[A-Za-z_][\w$]*/y],
  ],
  dockerfile: [
    ['comment', /#[^\n]*/y],
    [
      'keyword',
      /^(?:\s*)(?:ADD|ARG|CMD|COPY|ENTRYPOINT|ENV|EXPOSE|FROM|HEALTHCHECK|LABEL|ONBUILD|RUN|SHELL|STOPSIGNAL|USER|VOLUME|WORKDIR)\b/imy,
    ],
    ['string', /"(?:\\.|[^"\\])*"|'(?:[^'])*'/y],
    ['variable', /\$\{[^}]*\}|\$[A-Za-z_]\w*/y],
    ['flag', /(?<=\s)--[A-Za-z][\w-]*/y],
  ],
  yaml: [
    ['comment', /#[^\n]*/y],
    ['key', /^[ \t]*-?[ \t]*[\w.$-]+(?=\s*:)/my],
    ['string', /"(?:\\.|[^"\\])*"|'(?:[^'])*'/y],
    ['literal', /\b(?:true|false|null|yes|no|on|off)\b/y],
    ['number', /\b\d+(?:\.\d+)?\b/y],
    ['punct', /[:\-[\]{},]/y],
  ],
  env: [
    ['comment', /#[^\n]*/y],
    ['key', /^[ \t]*[A-Za-z_][\w]*(?==)/my],
    ['string', /"(?:\\.|[^"\\])*"|'(?:[^'])*'/y],
    ['operator', /=/y],
  ],
  prisma: [
    ['comment', /\/\/[^\n]*/y],
    ['keyword', /\b(?:datasource|generator|model|enum|type|view)\b/y],
    ['string', /"(?:\\.|[^"\\])*"/y],
    ['attr', /@@?[A-Za-z_]\w*/y],
    ['type', /\b(?:String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes|Unsupported)\b/y],
    ['number', /\b\d+\b/y],
    ['punct', /[{}()[\],?]/y],
  ],
  http: [
    ['keyword', /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|QUERY)\b/my],
    ['key', /^[A-Za-z][\w-]*(?=:)/my],
    ['string', /"(?:\\.|[^"\\])*"/y],
    ['number', /\b\d{3}\b/y],
  ],
}

const ALIASES = {
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  json5: 'json',
  jsonc: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  docker: 'dockerfile',
  yml: 'yaml',
  dotenv: 'env',
  ini: 'env',
}

/**
 * @param {string} code raw source
 * @param {string} lang fence language
 * @returns {string} HTML with <span class="tok-*"> wrappers, fully escaped
 */
export function highlight(code, lang) {
  const key = ALIASES[String(lang || '').toLowerCase()] ?? String(lang || '').toLowerCase()
  const grammar = GRAMMARS[key]
  const src = String(code).replace(/\r\n/g, '\n').replace(/\n$/, '')
  if (!grammar) return esc(src)

  let out = ''
  let pos = 0
  let guard = 0
  const max = src.length

  while (pos < max) {
    if (++guard > max * 4 + 1000) {
      // Defensive: never let a pathological rule spin forever during a build.
      out += esc(src.slice(pos))
      break
    }

    let matched = false
    for (const [type, re] of grammar) {
      re.lastIndex = pos
      const m = re.exec(src)
      if (m && m.index === pos && m[0].length > 0) {
        out += `<span class="tok-${type}">${esc(m[0])}</span>`
        pos += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      out += esc(src[pos])
      pos += 1
    }
  }
  return out
}

export const SUPPORTED_LANGUAGES = Object.keys(GRAMMARS)
export const LANGUAGE_ALIASES = ALIASES
