# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ComfyUIX** is a full-stack web application that provides a simplified, user-friendly interface for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (an AI image generation backend). The monorepo has two subdirectories:

- `client/` — Angular 20 SPA
- `server/` — NestJS 11 API (Fastify adapter) with SQLite

## Commands

### Client (`cd client`)

```bash
npm start          # Dev server on http://localhost:4200
npm run build      # Production build to dist/
npm test           # Karma/Jasmine unit tests
```

### Server (`cd server`)

```bash
npm run start:dev  # Watch mode dev server on http://localhost:8888
npm run build      # Compile TypeScript
npm run start:prod # Run compiled build
npm test           # Jest unit tests (rootDir: src, matches *.spec.ts)
npm run test:e2e   # Jest e2e (uses test/jest-e2e.json)
npm run lint       # ESLint with auto-fix
```

Run a single Jest test file:

```bash
npx jest src/books/books.service.spec.ts
```

## Architecture

### Domain Model

- **Book**: A connection to a ComfyUI instance. Stores `endpoint_base` (IP:port or domain), visibility (public/private), and optional password. UUID primary key.
- **Flow**: A ComfyUI workflow configuration saved to a book. Stored as JSON in `flow_data`. UUID primary key.
- **Asset**: Uploaded images (input/output type) linked to a book and user.
- **User**: Accounts with email verification and magic-link login.

### Server Structure (`server/src/`)

All modules follow the NestJS convention (module / service / controller). Raw SQL is used directly via `better-sqlite3` — **no ORM**. The `DatabaseService` (`database/database.service.ts`) holds the single SQLite connection and runs inline `CREATE TABLE IF NOT EXISTS` migrations on startup.

| Module     | Responsibility                                             |
| ---------- | ---------------------------------------------------------- |
| `database` | SQLite connection, schema migrations                       |
| `auth`     | JWT login, email verification, magic links, password reset |
| `users`    | User CRUD                                                  |
| `books`    | Book CRUD with ownership/password access checks            |
| `flows`    | Flow CRUD (access-gated through book ownership)            |
| `assets`   | Image upload/download                                      |
| `proxy`    | HTTP + WebSocket reverse proxy to ComfyUI instances        |
| `mail`     | Nodemailer email sending                                   |

The proxy (`proxy/proxy.controller.ts`) forwards all requests at `/proxy/:bookId/*` to the book's `endpoint_base`. WebSocket upgrades are handled directly in `main.ts` using the `http-proxy` library (outside Fastify's normal request pipeline).

### Client Structure (`client/src/app/`)

Angular 20 with standalone components and signals throughout.

| Path                                       | Purpose                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pages/book/`                              | Main UI for running flows against a ComfyUI instance; WebSocket connection for job progress |
| `pages/flowmaker/`                         | Multi-step wizard for creating/editing `FlowConfig` JSON                                    |
| `pages/books/`                             | Book list/management                                                                        |
| `pages/login/`                             | Auth UI                                                                                     |
| `comfyui/comfyui-database.service.ts`      | All HTTP calls to the NestJS backend; builds proxied endpoints                              |
| `comfyui/comfyui-upload.service.ts`        | File upload to ComfyUI via the proxy                                                        |
| `comfyui/comfyui-asset-storage.service.ts` | Local asset cache                                                                           |
| `auth/`                                    | `AuthService` (JWT storage), `authGuard`, HTTP interceptor                                  |
| `canvas-editor/`                           | Self-contained image editor component (see its own README)                                  |
| `types/flow.type.ts`                       | Core TypeScript types: `FlowConfig`, `Configurable`, `FlowTemplate`                         |

### FlowConfig Schema

The central data structure. Stored server-side as `flow_data` JSON, validated client-side in `ComfyUIDatabaseService.verifyFlowConfig()`:

- **`apiData`**: Raw ComfyUI API JSON (the workflow graph).
- **`configurables`**: Array of user-facing inputs. Each maps to a slash-path in `apiData` (e.g., `"/7/inputs/samples"`). Special IDs `positivePrompt` and `seed` are required and have `type: 'core'`.
- **`templates`**: Named presets. The first template must supply a `changes` entry for every non-core, non-image configurable. Template changes set `configId` → `value`.

### Environment Variables (server)

| Variable                                                              | Default            | Description      |
| --------------------------------------------------------------------- | ------------------ | ---------------- |
| `DB_PATH`                                                             | `./data/db.sqlite` | SQLite file path |
| `PORT`                                                                | `8888`             | HTTP listen port |
| JWT secret and mail config are loaded from `.env` via `dotenv/config` |

### Prettier Config

Both packages use Prettier with `printWidth: 100` and `singleQuote: true`. The client adds `"parser": "angular"` for `.html` files.
