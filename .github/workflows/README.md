# Workflows

`docs.yml` runs on every push to `main` and on every pull request. Its `validate` job checks out the repository on Node 24, rebuilds the site with `node scripts/build.mjs`, fails if the committed `docs/` output is stale, and then runs the four validators — `check.mjs`, `lint-sql.mjs`, `lint-snippets.mjs` and `check-deps.mjs`. Its `examples` job installs each `examples/*` package and runs `node scripts/run-examples.mjs`, which boots every example app and replays its smoke requests; examples that need a database report as skipped when no service is running.

Nothing here publishes the site. `docs/` is committed and GitHub Pages serves it directly: go to **Settings → Pages**, set **Source** to `Deploy from a branch`, choose branch `main` and folder `/docs`, and save. `docs/.nojekyll` is written by every build, so Jekyll leaves the generated files alone.
