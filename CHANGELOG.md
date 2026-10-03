# Changelog

All notable changes to **On Route** are documented here.

## [0.1.0] — 2026-09-25

First public release.

- Requests stored as YAML files under `.on_route/`, folders as directories.
- HTTP and WebSocket requests with params, headers, body (JSON, raw, URL-encoded, form data, binary), auth and docs.
- Endpoint scanning for Express, Fastify, Hono, Koa, Elysia, NestJS, Next.js, FastAPI, Flask, Django, Gin, Echo, Fiber, Chi, gorilla/mux, net/http, Spring, Laravel and Rails.
- Paste cURL into the URL bar; import Postman v2.0/v2.1 collections and environments.
- Code generation for 20 targets (cURL, fetch, axios, Python, Go, Java, Kotlin, C#, PHP, Ruby, Swift, Dart, Rust, …).
- Environments with per-environment *Commit to git* switch and locked (never committed) variables.
- Auth inheritance (request → folder → project): Bearer, Basic, API key.
- Response history, undo/redo everywhere, auto save, drag-to-reorder, typing suggestions.
