# Unverified / omitted claims — security pages (author B)

Author B owns: security-headers, https-and-tls, logging-without-leaking-pii.

Items deliberately left out of the three pages because they could not be verified
against official docs or the npm registry during authoring (2026-09-09):

- **Let's Encrypt short-lived (six-day) certificate profile.** Announced, but its
  general-availability status and whether it is the default for new orders could not
  be confirmed. `https-and-tls.md` states only the long-standing 90-day lifetime and
  the ~30-day renewal window, which are stable and documented.

- **Exact `pino` / `fast-redact` censor-function signature.** pino 10.3.1 documents
  `censor` as accepting a function, but whether the second argument is a path array
  or a joined string — and how it behaves for an `[*]` array path — was not verified.
  The page's censor example uses **only** the value argument, so it is correct under
  either signature. No claim is made about the path argument.

- **Interaction of `remove: true` with intermediate wildcards, and whether `remove`
  can be combined with a censor function.** Not verified. The page states only what is
  documented: `remove: true` drops the key instead of censoring it, and it applies to
  every path in that redaction configuration.

- **A named HTTP-client package for the "error carries credentials" example.** The
  obvious candidate (axios, whose errors expose `error.config.headers`) is not in the
  version table in CONTRIBUTING.md §1.3, so no version could be pinned. The page uses a
  hand-rolled `fetch` wrapper that attaches `err.config` instead — the same failure
  shape, no unpinned dependency. The redaction paths still cover
  `err.config.headers.*` and `err.response.config.headers.*` because that is the shape
  those clients produce.

- **Browser support matrices.** Exact browser versions for `Permissions-Policy`
  features, `Clear-Site-Data`, `Reporting-Endpoints`/`report-to`, and the removal of
  HPKP are described qualitatively ("support is not universal", "removed from
  browsers") rather than with version numbers or dates.

- **PCI DSS requirement numbers.** The substance is stated (the PAN must be masked
  where displayed or stored; the CVV must not be retained after authorization) without
  citing requirement numbers, which change between DSS versions.

- **Exact browser console message wording.** The Chrome CSP and `nosniff` refusal
  messages in `security-headers.md` are shown as representative, not quoted from a
  specific build. They are illustrative of the failure, not an API contract.

- **`X-Forwarded-Client-Cert` / `ssl-client-verify` header names.** Named as examples
  of what "your mesh calls it" rather than asserted as the header any particular
  product emits, because the name differs per proxy and mesh.

- **Whether any specific CDN caches 5xx responses by default.** The page says "many do,
  briefly, to shed load" — a general and true statement about negative caching — and
  names no product or default TTL.
