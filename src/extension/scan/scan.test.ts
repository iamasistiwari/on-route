import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore } from '../storage/projectStore';
import { endpointKey, joinPath, pathFromUrl, requestSlug, routeGroup } from './paths';
import { planScan } from './plan';
import { collectSources, globToRegExp, scanSources } from './scanner';
import type { ScannedRoute } from './types';

const scan = (files: Record<string, string>) => scanSources(Object.entries(files).map(([p, text]) => ({ path: p, text })));
const routesOf = (files: Record<string, string>) =>
  scan(files)
    .routes.map((r) => `${r.method} ${r.path}`)
    .sort();
const sorted = (xs: string[]) => [...xs].sort();

describe('paths', () => {
  it('names a request after the last path segment, keeping its case', () => {
    expect(requestSlug('/api/v1/gst/gst-to-contact')).toBe('gst-to-contact');
    expect(requestSlug('/Users/GetAll')).toBe('GetAll');
    expect(requestSlug('/users/:id')).toBe('users-by-id');
    expect(requestSlug('/orders/{orderId}/items/<int:item_id>')).toBe('items-by-item_id');
    expect(requestSlug('/')).toBe('root');
  });

  it('groups by the first segment after api / version prefixes', () => {
    expect(routeGroup('/api/v1/gst/gst-to-contact')).toBe('gst');
    expect(routeGroup('/health')).toBe('health');
    expect(routeGroup('/api/v2')).toBe('');
    expect(routeGroup('/:tenant/users')).toBe('');
  });

  it('treats every param syntax as the same endpoint', () => {
    const key = endpointKey('GET', '/users/:id');
    expect(endpointKey('GET', pathFromUrl('{{baseUrl}}/users/{{userId}}?expand=1'))).toBe(key);
    expect(endpointKey('GET', '/users/{user_id}/')).toBe(key);
    expect(endpointKey('POST', '/users/:id')).not.toBe(key);
  });

  it('joins prefixes, keeping a trailing slash only when asked', () => {
    expect(joinPath(['/api/', '/users', '/'])).toBe('/api/users');
    expect(joinPath(['/api/', '/users', '/'], true)).toBe('/api/users/');
    expect(joinPath(['', ''])).toBe('/');
  });

  it('matches exclude globs', () => {
    expect(globToRegExp('legacy/**').test('legacy/a/b.ts')).toBe(true);
    expect(globToRegExp('legacy/**').test('src/legacy/b.ts')).toBe(false);
    expect(globToRegExp('scripts').test('tools/scripts/x.py')).toBe(true);
    expect(globToRegExp('**/*.gen.ts').test('src/api/routes.gen.ts')).toBe(true);
  });
});

describe('JavaScript / TypeScript', () => {
  it('follows Express routers mounted across files and ignores HTTP clients and comments', () => {
    const result = scan({
      'package.json': JSON.stringify({ dependencies: { express: '^4.19.0', axios: '^1.0.0' } }),
      'src/app.ts': `import express from 'express';
import usersRouter from './routes/users';
import { gstRouter } from './routes/gst';
const app = express();
app.use(express.json());
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/gst', authMiddleware, gstRouter);
app.get('/health', (req, res) => res.send('ok'));
// app.get('/commented', handler);
app.listen(4000);`,
      'src/routes/users.ts': `import { Router } from 'express';
const router = Router();
router.get('/', list);
router.post('/', create);
router.route('/:id').get(show).put(update).delete(remove);
export default router;`,
      'src/routes/gst.ts': `import { Router } from 'express';
export const gstRouter = Router();
gstRouter.post('/gst-to-contact', handler);`,
      'src/client/api.ts': `import axios from 'axios';
const api = axios.create();
export const getUsers = () => api.get('/users', { params: {} });`,
    });
    expect(result.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      sorted([
        'GET /health',
        'GET /api/v1/users',
        'POST /api/v1/users',
        'GET /api/v1/users/:id',
        'PUT /api/v1/users/:id',
        'DELETE /api/v1/users/:id',
        'POST /api/v1/gst/gst-to-contact',
      ]),
    );
    expect(result.frameworks).toEqual(['Express']);
    expect(result.suggestedBaseUrl).toBe('http://localhost:4000');
    expect(result.routes.find((r) => r.path === '/health')).toMatchObject({ file: 'src/app.ts', line: 8 });
  });

  it('handles Fastify plugins, inline plugins with prefixes and route objects', () => {
    expect(
      routesOf({
        'package.json': JSON.stringify({ dependencies: { fastify: '^4' } }),
        'server.js': `const fastify = require('fastify')({ logger: true });
fastify.register(require('./routes/items'), { prefix: '/v1' });
fastify.register(async (instance) => {
  instance.get('/ping', async () => 'pong');
}, { prefix: '/internal' });
fastify.route({ method: ['GET', 'HEAD'], url: '/status', handler });`,
        'routes/items.js': `module.exports = async function (fastify, opts) {
  fastify.get('/items', async () => []);
  fastify.delete('/items/:id', async () => {});
};`,
      }),
    ).toEqual(sorted(['GET /internal/ping', 'GET /status', 'HEAD /status', 'GET /v1/items', 'DELETE /v1/items/:id']));
  });

  it('handles Hono chains, basePath and app.route', () => {
    expect(
      routesOf({
        'package.json': JSON.stringify({ dependencies: { hono: '^4' } }),
        'src/index.ts': `import { Hono } from 'hono';
import books from './books';
const app = new Hono().basePath('/api');
app.route('/books', books);
export default app;`,
        'src/books.ts': `import { Hono } from 'hono';
const books = new Hono()
  .get('/', (c) => {
    return c.json([]);
  })
  .post('/', (c) => c.json({}, 201));
export default books;`,
      }),
    ).toEqual(sorted(['GET /api/books', 'POST /api/books']));
  });

  it('reads NestJS controllers with a global prefix', () => {
    expect(
      routesOf({
        'src/main.ts': `const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
await app.listen(3000);`,
        'src/users/users.controller.ts': `@Controller('users')
export class UsersController {
  @Get()
  findAll() {}
  @Get(':id')
  findOne() {}
  @Post()
  create() {}
}`,
      }),
    ).toEqual(sorted(['GET /api/users', 'GET /api/users/:id', 'POST /api/users']));
  });

  it('reads Next.js route handlers and API pages', () => {
    expect(
      routesOf({
        'package.json': JSON.stringify({ dependencies: { next: '14.2.0' } }),
        'app/api/users/[id]/route.ts': `export async function GET(req) {}
export async function DELETE(req) {}`,
        'src/app/(admin)/api/stats/route.ts': `export const POST = async () => {};`,
        'pages/api/hello.ts': `export default function handler(req, res) { if (req.method === 'POST') {} }`,
      }),
    ).toEqual(sorted(['GET /api/users/:id', 'DELETE /api/users/:id', 'POST /api/stats', 'POST /api/hello']));
  });
});

describe('Python', () => {
  it('follows FastAPI routers, prefixes and include_router', () => {
    expect(
      routesOf({
        'app/main.py': `from fastapi import FastAPI
from app.routers import users
from .routers.items import router as items_router

app = FastAPI()
app.include_router(users.router, prefix="/api/v1")
app.include_router(items_router)

@app.get("/health")
def health():
    return {"ok": True}

# @app.get("/commented")
`,
        'app/routers/__init__.py': '',
        'app/routers/users.py': `from fastapi import APIRouter
router = APIRouter(prefix="/users", tags=["users"])

@router.get("/")
async def list_users(): ...

@router.post("/{user_id}/activate")
async def activate(user_id: int): ...
`,
        'app/routers/items.py': `from fastapi import APIRouter
router = APIRouter(prefix="/items")

@router.put("/{item_id}")
def update(): ...
`,
      }),
    ).toEqual(sorted(['GET /api/v1/users/', 'POST /api/v1/users/:user_id/activate', 'PUT /items/:item_id', 'GET /health']));
  });

  it('follows Flask blueprints', () => {
    expect(
      routesOf({
        'app.py': `from flask import Flask
from views.users import bp as users_bp
app = Flask(__name__)
app.register_blueprint(users_bp, url_prefix="/api/users")

@app.route("/")
def index(): ...

@app.route("/login", methods=["GET", "POST"])
def login(): ...
`,
        'views/users.py': `from flask import Blueprint
bp = Blueprint("users", __name__, url_prefix="/ignored")

@bp.get("/<int:user_id>")
def show(user_id): ...
`,
      }),
    ).toEqual(sorted(['GET /', 'GET /login', 'POST /login', 'GET /api/users/:user_id']));
  });

  it('follows Django includes, class-based views and DRF routers', () => {
    expect(
      routesOf({
        'mysite/urls.py': `from django.urls import include, path
urlpatterns = [
    path('api/', include('blog.urls')),
    path('admin/', admin.site.urls),
]`,
        'blog/urls.py': `from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
router = DefaultRouter()
router.register(r'posts', views.PostViewSet)
urlpatterns = [
    path('authors/<int:pk>/', views.AuthorDetail.as_view()),
    path('ping/', views.ping),
    path('', include(router.urls)),
]`,
        'blog/views.py': `from rest_framework import generics, viewsets
from rest_framework.decorators import api_view

class PostViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Post.objects.all()

class AuthorDetail(generics.RetrieveUpdateAPIView):
    pass

@api_view(['POST'])
def ping(request):
    pass
`,
      }),
    ).toEqual(
      sorted([
        'GET /api/authors/:pk/',
        'PUT /api/authors/:pk/',
        'PATCH /api/authors/:pk/',
        'POST /api/ping/',
        'GET /api/posts/',
        'GET /api/posts/:pk/',
      ]),
    );
  });
});

describe('Go', () => {
  it('follows Gin groups, including groups passed to functions in other packages', () => {
    const result = scan({
      'main.go': `package main

import (
	"github.com/gin-gonic/gin"
	"example.com/app/routes"
)

func main() {
	r := gin.Default()
	r.GET("/health", health)
	api := r.Group("/api")
	v1 := api.Group("/v1")
	{
		v1.POST("/gst/gst-to-contact", handlers.GstToContact)
		// v1.GET("/commented", x)
	}
	routes.RegisterUserRoutes(v1.Group("/users"))
	r.Run(":8081")
}`,
      'routes/users.go': `package routes

import "github.com/gin-gonic/gin"

func RegisterUserRoutes(rg *gin.RouterGroup) {
	rg.GET("", listUsers)
	rg.GET("/:id", getUser)
	rg.DELETE("/:id", deleteUser)
}`,
    });
    expect(result.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      sorted(['GET /health', 'POST /api/v1/gst/gst-to-contact', 'GET /api/v1/users', 'GET /api/v1/users/:id', 'DELETE /api/v1/users/:id']),
    );
    expect(result.frameworks).toEqual(['Gin']);
    expect(result.suggestedBaseUrl).toBe('http://localhost:8081');
  });

  it('follows Chi Route closures and Go 1.22 ServeMux patterns', () => {
    expect(
      routesOf({
        'cmd/server/main.go': `package main

import (
	"net/http"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/", home)
	r.Route("/articles", func(r chi.Router) {
		r.Get("/", list)
		r.Route("/{articleID}", func(r chi.Router) {
			r.Put("/", update)
		})
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", getItem)
	http.ListenAndServe(":3333", r)
}`,
      }),
    ).toEqual(sorted(['GET /', 'GET /articles', 'PUT /articles/:articleID', 'GET /items/:id']));
  });

  it('reads gorilla/mux subrouters and Methods()', () => {
    expect(
      routesOf({
        'server.go': `package main

import "github.com/gorilla/mux"

func routes() {
	r := mux.NewRouter()
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/users/{id:[0-9]+}", getUser).Methods("GET", "PUT")
}`,
      }),
    ).toEqual(sorted(['GET /api/users/:id', 'PUT /api/users/:id']));
  });
});

describe('Spring, Laravel, Rails', () => {
  it('reads Spring controllers with class mappings and context path', () => {
    const result = scan({
      'src/main/resources/application.properties': 'server.port=9090\nserver.servlet.context-path=/svc\n',
      'src/main/java/com/acme/UserController.java': `@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping
  public List<User> all() { return null; }

  @GetMapping("/{id}")
  public User one(@PathVariable Long id) { return null; }

  @PostMapping(value = "/bulk", consumes = "application/json")
  public void bulk() {}

  @RequestMapping(value = "/search", method = RequestMethod.POST)
  public void search() {}
}`,
    });
    expect(result.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      sorted(['GET /svc/api/users', 'GET /svc/api/users/:id', 'POST /svc/api/users/bulk', 'POST /svc/api/users/search']),
    );
    expect(result.suggestedBaseUrl).toBe('http://localhost:9090');
  });

  it('reads Laravel routes with prefix groups and resources', () => {
    expect(
      routesOf({
        'routes/api.php': `<?php
Route::get('/user', fn () => 1);
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::post('/gst/gst-to-contact', [GstController::class, 'contact']);
    Route::apiResource('photos', PhotoController::class)->only(['index', 'show']);
});
// Route::get('/commented', fn () => 1);
`,
      }),
    ).toEqual(sorted(['GET /api/user', 'POST /api/v1/gst/gst-to-contact', 'GET /api/v1/photos', 'GET /api/v1/photos/:photo']));
  });

  it('reads Rails namespaces, resources and member routes', () => {
    expect(
      routesOf({
        'config/routes.rb': `Rails.application.routes.draw do
  root "home#index"
  namespace :api do
    namespace :v1 do
      resources :users, only: [:index, :show] do
        resources :posts, only: %i[create]
        member do
          post :activate
        end
      end
      get "gst/gst-to-contact", to: "gst#contact"
    end
  end
  # get "commented"
end`,
      }),
    ).toEqual(
      sorted([
        'GET /',
        'GET /api/v1/users',
        'GET /api/v1/users/:id',
        'POST /api/v1/users/:user_id/posts',
        'POST /api/v1/users/:id/activate',
        'GET /api/v1/gst/gst-to-contact',
      ]),
    );
  });
});

describe('planScan', () => {
  const route = (method: ScannedRoute['method'], p: string): ScannedRoute => ({ method, path: p, framework: 'Express', file: 'src/app.ts', line: 1 });
  const summary = (plan: ReturnType<typeof planScan>) =>
    plan.groups.map((g) => ({ folder: g.folderId ?? `new:${g.newFolder}`, requests: g.requests.map((r) => `${r.request.method} ${r.slug} ${r.request.url}`) }));

  it('groups routers into folders, names files after the last segment and adds a method suffix when a path has several methods', () => {
    const plan = planScan(
      [
        route('POST', '/api/v1/gst/gst-to-contact'),
        route('GET', '/api/v1/gst/gst-to-pan'),
        route('GET', '/health'),
        route('GET', '/users'),
        route('POST', '/users'),
        route('GET', '/users/:id'),
      ],
      { folders: [], requests: [] },
      [],
    );
    expect(summary(plan)).toEqual([
      {
        folder: 'new:gst',
        requests: ['POST gst-to-contact {{baseUrl}}/api/v1/gst/gst-to-contact', 'GET gst-to-pan {{baseUrl}}/api/v1/gst/gst-to-pan'],
      },
      { folder: '', requests: ['GET health {{baseUrl}}/health'] },
      { folder: 'new:users', requests: ['GET users {{baseUrl}}/users', 'POST users-post {{baseUrl}}/users', 'GET users-by-id {{baseUrl}}/users/:id'] },
    ]);
    expect(plan.added).toBe(6);
    expect(plan.groups[0].requests[0].request.body).toEqual({ type: 'json', content: '{}' });
  });

  it('never re-adds endpoints the user renamed, moved or deleted', () => {
    const routes = [route('POST', '/api/v1/gst/gst-to-contact'), route('GET', '/api/v1/gst/gst-to-pan'), route('GET', '/health')];
    const plan = planScan(
      routes,
      {
        folders: [{ id: 'my-gst', name: 'My GST', auth: { type: 'inherit' }, variables: [] }],
        // gst-to-contact was renamed and moved into "my-gst" by the user.
        requests: [{ id: 'my-gst/contact-lookup', folderId: 'my-gst', name: 'Contact lookup', method: 'POST', url: '{{baseUrl}}/api/v1/gst/gst-to-contact' }],
      },
      // /health was added earlier and then deleted by the user.
      ['GET /health'],
    );
    expect(summary(plan)).toEqual([{ folder: 'my-gst', requests: ['GET gst-to-pan {{baseUrl}}/api/v1/gst/gst-to-pan'] }]);
    expect(plan.known).toEqual(['GET /api/v1/gst/gst-to-pan', 'GET /health', 'POST /api/v1/gst/gst-to-contact']);
  });
});

describe('workspace files', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'on-route-scan-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };

  it('skips dependency folders, dot folders and excluded globs', async () => {
    await write('src/app.js', "app.get('/a', h)");
    await write('node_modules/lib/index.js', "app.get('/b', h)");
    await write('.next/server.js', "app.get('/c', h)");
    await write('legacy/old.js', "app.get('/d', h)");
    await write('README.md', '# hi');
    const { files } = await collectSources(root, ['legacy/**']);
    expect(files.map((f) => f.path)).toEqual(['src/app.js']);
  });

  it('creates case-preserving files and remembers handled endpoints', async () => {
    const store = new ProjectStore(root);
    await store.init('Demo');
    const folder = await store.createFolder('', 'GST', { slug: 'GST' });
    const req = await store.createRequest(folder.id, 'gst-To-Contact', { method: 'POST' }, { slug: 'gst-To-Contact' });
    expect(req.id).toBe('GST/gst-To-Contact');
    expect((await store.load()).requests.map((r) => r.id)).toEqual(['GST/gst-To-Contact']);

    expect(await store.readScanState()).toBeUndefined();
    await store.writeScanState({ known: ['POST /b', 'GET /a', 'GET /a'] });
    expect(await store.readScanState()).toEqual({ known: ['GET /a', 'POST /b'] });
  });
});
