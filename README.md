# On Route

A fast, git-friendly API client for VS Code. Every endpoint is a YAML file in your repo under `.on_route/`, so requests are reviewed, diffed, and shared like code.

## Features
- **Requests in the repo**: one YAML file per request; folders are directories.
- **Paste cURL**: paste a curl command into the URL bar and the request fills itself in. Chrome/Firefox "Copy as cURL" (bash and cmd) are supported. There is also a *Import from cURL (clipboard)* command.
- **Export**: copy any request as **cURL** or **axios**, with variables resolved or kept as `{{placeholders}}`.
- **Overview**: one page for endpoints, project authorization, variables, and environments.
- **Auth inheritance**: request → folder → project. Supports Bearer, Basic, and API key (header or query).
- **Environments and secrets**: each environment has a *Commit to git* switch (off by default: `environments/<name>.yaml` is listed in `.on_route/.gitignore`). Locked variables are never committed: project ones live in `.on_route/variables.local.yaml`, environment ones in `environments/<name>.local.yaml`. New variables start locked.
- **Undo everywhere**: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z undo and redo every edit in a request (URL, params, headers, body, auth, docs), also after auto save.
- **Response history**: the last 20 responses per request are kept in `.on_route/.history/` (gitignored).
- **Postman import**: v2.0 and v2.1 collections, plus environment exports.
- **Auto save** (off by default): turn it on in *Overview → Settings* and pick *Immediately* or an interval (10 s to 5 min). Open requests and overview edits are saved automatically.
- **Drag to reorder**: drag requests and folders to reorder them inside a folder or move them to another one. The position is stored as `order` in the files, and scans add new endpoints after the ones you arranged.
- **Typing suggestions**: the URL bar suggests path segments and endpoints from your project, common words, query params and variables (Tab accepts). The JSON body editor suggests keys and values used by similar requests, and an empty body offers "Start from" bodies of requests in the same folder.
- **Folder actions**: right-click a folder (or use its ⋯ button) to add a request or subfolder, rename it, or delete it after a confirmation.
- **Endpoint scanning**: reads your server code and adds every route as a request, one folder per router. Runs when the project is initialized, when it opens, and every 10 minutes (configurable, or off), plus a *Scan Project for Endpoints* button. Supports Express, Fastify, Hono, Koa, Elysia, NestJS, Next.js, FastAPI, Flask, Django (incl. DRF), Gin, Echo, Fiber, Chi, gorilla/mux, net/http, Spring, Laravel and Rails. Files are named after the last path segment with its case kept (`/api/v1/gst/gst-to-contact` becomes `gst/gst-to-contact.yaml`). A scan only ever adds new endpoints: requests you renamed, moved or deleted are left as they are.

## Layout
```
.on_route/
  on_route.json               # project name, auth, unlocked variables, scan settings
  variables.local.yaml        # locked project variables (gitignored)
  scan.json                   # endpoints already handled by the scanner
  .gitignore                  # *.local.yaml, .history/, environments that are not committed
  environments/
    dev.yaml
    dev.local.yaml            # gitignored
  requests/
    users/
      _folder.yaml            # folder auth + variables (optional)
      get-user.yaml
```

```yaml
name: Get user
method: GET
url: "{{baseUrl}}/users/{{userId}}"
headers:
  - key: Accept
    value: application/json
```

Variable precedence, lowest to highest: project, then folders (outer to inner), then environment, then local overrides.
Dynamic variables: `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`.

## Shortcuts
| Key | Action |
|---|---|
| `Ctrl/Cmd+Enter` | Send request |
| `Ctrl/Cmd+S` | Save request |
| `Ctrl/Cmd+Alt+E` | Switch environment |

## Settings
`onRoute.timeoutMs`, `onRoute.rejectUnauthorized`, `onRoute.followRedirects`, `onRoute.historyLimit`, `onRoute.autoSave`, `onRoute.autoSaveIntervalSeconds`.

## Development
```bash
npm install
npm run build      # extension (esbuild) + webview (vite)
npm test           # vitest
npm run typecheck
```
Press **F5** in VS Code to launch an Extension Development Host. Run `npm run package` to build a `.vsix`.
