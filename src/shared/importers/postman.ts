// OWNER: agent "core-logic".
import type {
  AuthConfig,
  BodyConfig,
  Environment,
  FolderDef,
  FormField,
  HttpMethod,
  KeyValue,
  ProjectConfig,
  RequestDef,
  Variable,
} from '../model';
import { HTTP_METHODS } from '../model';

export interface PostmanImportResult {
  config: ProjectConfig;
  folders: FolderDef[];
  requests: RequestDef[];
  environments: Environment[];
  warnings: string[];
}

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (x === undefined || x === null ? '' : typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x));

function slugify(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** Tracks used ids per parent to de-duplicate with -2, -3 suffixes. */
class IdAllocator {
  private used = new Map<string, Set<string>>();
  alloc(parent: string, slug: string): string {
    let set = this.used.get(parent);
    if (!set) this.used.set(parent, (set = new Set()));
    let candidate = slug;
    for (let n = 2; set.has(candidate); n++) candidate = `${slug}-${n}`;
    set.add(candidate);
    return parent ? `${parent}/${candidate}` : candidate;
  }
}

function description(d: unknown): string | undefined {
  if (typeof d === 'string') return d || undefined;
  if (isObj(d) && typeof d.content === 'string') return d.content || undefined;
  return undefined;
}

function withOptional<T extends object>(base: T, extras: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) out[k] = v;
  return out as T;
}

function keyValues(list: unknown): KeyValue[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((row) =>
    withOptional<KeyValue>(
      { key: str(row.key), value: str(row.value) },
      { enabled: row.disabled === true ? false : undefined, description: description(row.description) },
    ),
  );
}

function headers(h: unknown): KeyValue[] {
  if (typeof h === 'string') {
    // v2.0 allows "Key: value\nKey2: value2"
    return h
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(':');
        return idx < 0 ? { key: line, value: '' } : { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      });
  }
  return keyValues(h);
}

function variables(list: unknown): Variable[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isObj)
    .map((v) =>
      withOptional<Variable>(
        { key: str(v.key ?? v.id), value: str(v.value) },
        {
          enabled: v.disabled === true || v.enabled === false ? false : undefined,
          secret: v.type === 'secret' ? true : undefined,
          description: description(v.description),
        },
      ),
    )
    .filter((v) => v.key !== '');
}

/** Build url + params from a Postman url (string or object). Query items become params. */
function mapUrl(u: unknown): { url: string; params: KeyValue[] } {
  if (typeof u === 'string') return { url: u, params: [] };
  if (!isObj(u)) return { url: '', params: [] };

  const params = keyValues(u.query);
  let url: string;
  if (typeof u.raw === 'string' && u.raw) {
    url = u.raw;
    if (Array.isArray(u.query) && u.query.length > 0) {
      // query is represented as params; strip it from the raw url to avoid duplication
      const hashIdx = url.indexOf('#');
      const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      const q = base.indexOf('?');
      url = (q >= 0 ? base.slice(0, q) : base) + hash;
    }
  } else {
    const protocol = typeof u.protocol === 'string' && u.protocol ? `${u.protocol.replace(/:?\/*$/, '')}://` : '';
    const host = Array.isArray(u.host) ? u.host.map(str).join('.') : str(u.host);
    const port = u.port !== undefined && u.port !== '' ? `:${str(u.port)}` : '';
    const pathSegs = Array.isArray(u.path)
      ? u.path.map((p) => (isObj(p) ? str(p.value) : str(p)))
      : typeof u.path === 'string'
        ? [u.path.replace(/^\//, '')]
        : [];
    const path = pathSegs.length ? `/${pathSegs.join('/')}` : '';
    const hash = typeof u.hash === 'string' && u.hash ? `#${u.hash}` : '';
    url = `${protocol}${host}${port}${path}${hash}`;
  }
  return { url, params };
}

/** Read a Postman auth parameter: v2.1 array of {key,value}, v2.0 plain object. */
function authParam(params: unknown, key: string): string {
  if (Array.isArray(params)) {
    const found = params.find((p) => isObj(p) && p.key === key);
    return isObj(found) ? str(found.value) : '';
  }
  if (isObj(params)) return str(params[key]);
  return '';
}

function mapAuth(a: unknown, where: string, warnings: string[], fallback: AuthConfig): AuthConfig {
  if (!isObj(a) || typeof a.type !== 'string') return fallback;
  switch (a.type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: authParam(a.bearer, 'token') };
    case 'basic':
      return { type: 'basic', username: authParam(a.basic, 'username'), password: authParam(a.basic, 'password') };
    case 'apikey':
      return {
        type: 'apikey',
        key: authParam(a.apikey, 'key'),
        value: authParam(a.apikey, 'value'),
        in: authParam(a.apikey, 'in') === 'query' ? 'query' : 'header',
      };
    default:
      warnings.push(`${where}: auth type "${a.type}" is not supported; using ${fallback.type}.`);
      return fallback;
  }
}

const RAW_LANGUAGE_TYPES: Record<string, string> = {
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

function mapBody(b: unknown, hdrs: KeyValue[], where: string, warnings: string[]): BodyConfig {
  if (!isObj(b) || typeof b.mode !== 'string') return { type: 'none' };
  if (b.disabled === true) return { type: 'none' };
  switch (b.mode) {
    case 'raw': {
      const content = str(b.raw);
      const options = isObj(b.options) && isObj(b.options.raw) ? b.options.raw : undefined;
      const language = options && typeof options.language === 'string' ? options.language : undefined;
      const headerType = hdrs.find((h) => h.key.toLowerCase() === 'content-type' && h.enabled !== false)?.value;
      if (language === 'json' || (!language && headerType && /json/i.test(headerType))) {
        return { type: 'json', content };
      }
      const contentType = language ? RAW_LANGUAGE_TYPES[language] : undefined;
      return contentType ? { type: 'raw', content, contentType } : { type: 'raw', content };
    }
    case 'urlencoded':
      return { type: 'urlencoded', fields: keyValues(b.urlencoded) };
    case 'formdata': {
      const rows = Array.isArray(b.formdata) ? b.formdata.filter(isObj) : [];
      const fields: FormField[] = rows.map((row) => {
        const isFile = row.type === 'file';
        let value: string;
        if (isFile) {
          if (Array.isArray(row.src)) {
            if (row.src.length > 1) warnings.push(`${where}: form field "${str(row.key)}" has multiple files; only the first is kept.`);
            value = str(row.src[0]);
          } else value = str(row.src);
        } else value = str(row.value);
        return withOptional<FormField>(
          { key: str(row.key), value, kind: isFile ? 'file' : 'text' },
          { enabled: row.disabled === true ? false : undefined, description: description(row.description) },
        );
      });
      return { type: 'form', fields };
    }
    case 'file': {
      const file = isObj(b.file) ? b.file : {};
      if (typeof file.src === 'string' && file.src) return { type: 'binary', filePath: file.src };
      if (typeof file.content === 'string') return { type: 'raw', content: file.content };
      return { type: 'binary', filePath: '' };
    }
    case 'graphql': {
      const g = isObj(b.graphql) ? b.graphql : {};
      let vars: unknown = {};
      if (typeof g.variables === 'string' && g.variables.trim()) {
        try {
          vars = JSON.parse(g.variables);
        } catch {
          vars = g.variables;
        }
      } else if (isObj(g.variables)) vars = g.variables;
      warnings.push(`${where}: GraphQL body converted to a JSON body.`);
      return { type: 'json', content: JSON.stringify({ query: str(g.query), variables: vars }, null, 2) };
    }
    default:
      warnings.push(`${where}: body mode "${b.mode}" is not supported; body dropped.`);
      return { type: 'none' };
  }
}

/**
 * Convert a Postman Collection v2.0/v2.1 JSON (and optional Postman environment JSON exports)
 * into On Route entities. Folder/request ids are slugified names (lowercase, a-z0-9 and '-'),
 * nested with '/', de-duplicated with -2, -3 suffixes. Maps: url (string or object with raw),
 * query, header, body modes raw (json if options.raw.language==='json'), urlencoded, formdata,
 * file; auth bearer/basic/apikey/noauth (others => warning + inherit); collection variables;
 * item descriptions => docs. Disabled rows => enabled:false. Sets order by position.
 * Throws Error with a clear message if the input is not a Postman collection.
 */
export function importPostman(collection: unknown, environments: unknown[] = []): PostmanImportResult {
  if (!isObj(collection) || !isObj(collection.info) || !Array.isArray(collection.item)) {
    if (isObj(collection) && Array.isArray(collection.requests)) {
      throw new Error('Postman Collection v1 format is not supported. Re-export the collection as v2.1 from Postman.');
    }
    throw new Error("Not a Postman collection: expected a JSON object with 'info' and 'item' (Postman Collection v2.0/v2.1).");
  }
  const info = collection.info;
  const schema = typeof info.schema === 'string' ? info.schema : '';
  if (schema && !/v2\.[01]/.test(schema)) {
    throw new Error(`Unsupported Postman collection schema "${schema}". Supported: v2.0, v2.1.`);
  }

  const warnings: string[] = [];
  const folders: FolderDef[] = [];
  const requests: RequestDef[] = [];
  const ids = new IdAllocator();
  let scriptCount = 0;

  const config: ProjectConfig = withOptional<ProjectConfig>(
    {
      version: 1,
      name: str(info.name) || 'Imported Collection',
      auth: mapAuth(collection.auth, 'Collection', warnings, { type: 'none' }),
      variables: variables(collection.variable),
    },
    { docs: description(info.description) },
  );
  if (Array.isArray(collection.event) && collection.event.length) scriptCount++;

  const walk = (items: unknown[], parent: string, trail: string) => {
    items.forEach((raw, index) => {
      if (!isObj(raw)) return;
      const name = str(raw.name) || (Array.isArray(raw.item) ? 'Folder' : 'Request');
      const where = trail ? `${trail} / ${name}` : name;
      if (Array.isArray(raw.event) && raw.event.length) scriptCount++;

      if (Array.isArray(raw.item)) {
        const id = ids.alloc(parent, slugify(name, 'folder'));
        folders.push(
          withOptional<FolderDef>(
            {
              id,
              name,
              auth: mapAuth(raw.auth, where, warnings, { type: 'inherit' }),
              variables: variables(raw.variable),
              order: index,
            },
            { docs: description(raw.description) },
          ),
        );
        walk(raw.item, id, where);
        return;
      }

      const id = ids.alloc(parent, slugify(name, 'request'));
      const r: Obj = typeof raw.request === 'string' ? { url: raw.request, method: 'GET' } : isObj(raw.request) ? raw.request : {};
      const methodRaw = str(r.method || 'GET').toUpperCase();
      let method: HttpMethod = 'GET';
      if ((HTTP_METHODS as readonly string[]).includes(methodRaw)) method = methodRaw as HttpMethod;
      else warnings.push(`${where}: method "${methodRaw}" is not supported; using GET.`);

      const { url, params } = mapUrl(r.url);
      const hdrs = headers(r.header);
      requests.push(
        withOptional<RequestDef>(
          {
            id,
            name,
            method,
            url,
            params,
            headers: hdrs,
            auth: mapAuth(r.auth, where, warnings, { type: 'inherit' }),
            body: mapBody(r.body, hdrs, where, warnings),
            order: index,
          },
          { docs: description(r.description) ?? description(raw.description) },
        ),
      );
    });
  };
  walk(collection.item, '', '');

  if (scriptCount > 0) {
    warnings.push(`${scriptCount} item(s) contain pre-request/test scripts, which are not imported.`);
  }

  const envs: Environment[] = [];
  const envNames = new IdAllocator();
  environments.forEach((env, i) => {
    if (!isObj(env) || !Array.isArray(env.values)) {
      warnings.push(`Environment #${i + 1} is not a Postman environment export; skipped.`);
      return;
    }
    const name = envNames.alloc('', slugify(str(env.name), `environment-${i + 1}`));
    envs.push({ name, variables: variables(env.values) });
  });

  return { config, folders, requests, environments: envs, warnings };
}
