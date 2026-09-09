# Workflows

`docs.yml` runs on every push to `main` and on every pull request. Its `validate` job checks out the repository on Node 24, rebuilds the site with `node scripts/build.mjs`, fails if the committed `docs/` output is stale, and then runs the four validators — `check.mjs`, `lint-sql.mjs`, `lint-snippets.mjs` and `check-deps.mjs`. Its `examples` job installs each `examples/*` package and runs `node scripts/run-examples.mjs`, which boots every example app and replays its smoke requests; examples that need a database report as skipped when no service is running.

`pages.yml` publishes the site. `docs/` is committed and already HTML, so the workflow builds nothing: it uploads the directory verbatim with `actions/upload-pages-artifact` and deploys it with `actions/deploy-pages`. It runs on pushes to `main` that touch `docs/`, and on demand via **Run workflow**.

This requires **Settings → Pages → Source: `GitHub Actions`**. Do not switch it back to `Deploy from a branch`: that mode runs GitHub's `pages-build-deployment`, which calls `actions/jekyll-build-pages`, which invokes `github-pages build` unconditionally — it never checks for `.nojekyll`. The generated site then gets a Jekyll pass it does not need and the build fails in the default theme's Sass (`Error: No such file or directory @ dir_chdir0 - /github/workspace/docs`).
