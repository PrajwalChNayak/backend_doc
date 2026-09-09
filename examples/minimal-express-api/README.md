# minimal-express-api

The smallest honest Express 5 API. No framework-on-top-of-the-framework, no
`asyncHandler` wrapper, no folder ceremony — just the pieces every Express 5 app
actually needs.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `app.js` exports the app, `server.js` binds the port | `src/app.js`, `src/server.js` |
| `app.listen(port, (err) => …)` — Express 5 passes bind errors to the callback | `src/server.js` |
| `express.json()` from the bundled body-parser (never install `body-parser`) | `src/app.js` |
| Express 5 catch-all 404 with `'/{*splat}'` (bare `'/*'` throws) | `src/app.js` |
| A four-argument error handler that hides 5xx details | `src/app.js` |
| Rejected promises reach the error handler with no wrapper | `GET /boom` |
| `req.body` is `undefined`, not `{}`, when no parser ran | `POST /notes` |
| `app.delete()` — `app.del()` was removed | `DELETE /notes/:id` |

## Prerequisites

- Node.js 24 LTS (`node --version` should print `v24.x`)

## Install and run

```bash
cd examples/minimal-express-api
npm install
npm start
```

The server listens on `http://localhost:3001`. Override with `PORT`:

```bash
PORT=4000 npm start
```

Run the tests:

```bash
npm test
```

## Routes

### `GET /health`

```bash
curl -s http://localhost:3001/health
```

```json
{"status":"ok"}
```

### `GET /notes`

```bash
curl -s http://localhost:3001/notes
```

```json
{"data":[]}
```

### `POST /notes`

```bash
curl -s -X POST http://localhost:3001/notes \
  -H 'content-type: application/json' \
  -d '{"title":"buy milk"}'
```

```json
{"data":{"id":"0d0e…","title":"buy milk","done":false,"createdAt":"2026-09-08T…Z"}}
```

Missing or blank title:

```bash
curl -s -i -X POST http://localhost:3001/notes \
  -H 'content-type: application/json' -d '{}'
```

```
HTTP/1.1 400 Bad Request
{"error":{"message":"title must be a non-empty string"}}
```

### `GET /notes/:id`

```bash
curl -s http://localhost:3001/notes/<id>
```

Unknown id returns `404` with `{"error":{"message":"Note not found"}}`.

### `DELETE /notes/:id`

```bash
curl -s -i -X DELETE http://localhost:3001/notes/<id>
```

`204 No Content` on success, `404` if it was already gone.

### `GET /boom`

```bash
curl -s -i http://localhost:3001/boom
```

```
HTTP/1.1 500 Internal Server Error
{"error":{"message":"Internal Server Error"}}
```

The handler is `async` and simply `throw`s. Express 5 forwards the rejection to
the error middleware for you — this is the single biggest reason
`express-async-handler` is obsolete.

### Anything else

```bash
curl -s -i http://localhost:3001/nope
```

```
HTTP/1.1 404 Not Found
{"error":{"message":"Cannot GET /nope"}}
```

## What to read in the source

Read `src/app.js` top to bottom; it is under 80 lines. The two lines worth
staring at are the 404 mount path (`'/{*splat}'`, because path-to-regexp v8
rejects `'/*'`) and the four-argument error handler, whose `next` parameter must
stay even though it is unused — Express detects error middleware by arity.
