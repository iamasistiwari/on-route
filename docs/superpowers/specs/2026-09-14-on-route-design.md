# On Route — Design

VS Code extension: Postman-like API client whose data lives in the repo under `.on_route/`.

## Decisions
- Storage: one YAML file per request; folders = directories with optional `_folder.yaml`; `on_route.json` project config; `environments/<name>.yaml` (+ gitignored `<name>.local.yaml`).
- Secrets: variables flagged `secret: true` are committed with empty value; real values live in `<env>.local.yaml` (gitignored). SecretStorage deferred.
- Variable precedence (low → high): project < folders (outer → inner) < environment < local overrides. Dynamic: `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`.
- Auth: none / bearer / basic / apikey (header|query) / inherit; resolved request → folder chain → project.
- Execution: extension host via undici (no CORS, TLS toggle, cancel, timing).
- UI: native TreeView sidebar; React + Vite + Tailwind webviews (request editor, overview); CodeMirror 6.
- v1 extras: response history (`.on_route/.history/`, gitignored, 20 per request), Postman v2.x import.
- curl: paste into URL bar auto-fills; import from clipboard command. Export: curl, axios.

## Modules
| Path | Responsibility |
|---|---|
| `src/shared/model.ts`, `protocol.ts` | types + webview message protocol |
| `src/shared/variables.ts`, `auth.ts` | resolution pipeline (pure) |
| `src/shared/importers/curl.ts`, `codegen/*` | curl parse, curl/axios generate (pure) |
| `src/shared/importers/postman.ts` | Postman → model (pure) |
| `src/extension/storage/projectStore.ts` | `.on_route` fs read/write, zod validation |
| `src/extension/history/historyStore.ts` | response history |
| `src/extension/http/executor.ts` | undici execution |
| `src/extension/extension.ts`, `views/`, `panels/`, `services/` | VS Code wiring |
| `src/webview/` | React UI |

## Errors
- Bad YAML → Problems panel diagnostic + tree warning; file skipped.
- Network/TLS/timeout → shown in response pane with code + timing.
- External file change → reload editor if clean, prompt if dirty.

## Testing
vitest unit tests for all pure modules (curl parser table, curl round-trip, resolver, auth inheritance, YAML round-trip, Postman mapping, executor against local http server).
