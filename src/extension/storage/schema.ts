// OWNER: agent "storage". zod schemas for files under .on_route/ plus serializers (model -> plain file object).
import { z } from 'zod';
import {
  REQUEST_METHODS,
  type AuthConfig,
  type BodyConfig,
  type Environment,
  type FolderDef,
  type FormField,
  type KeyValue,
  type ProjectConfig,
  type RequestDef,
  type Variable,
} from '../../shared/model';

/** Scalar coerced to string (YAML may type `value: 123` as a number; `value:` as null). */
const str = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((v) => (v === null ? '' : String(v)));

const optStr = z.string().optional();

export const keyValueSchema = z.object({
  key: str,
  value: str.default(''),
  enabled: z.boolean().optional(),
  description: optStr,
});

export const formFieldSchema = keyValueSchema.extend({
  kind: z.enum(['text', 'file']).optional(),
});

export const variableSchema = z.object({
  key: str,
  value: str.default(''),
  enabled: z.boolean().optional(),
  secret: z.boolean().optional(),
  description: optStr,
});

export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: str.default('') }),
  z.object({ type: z.literal('basic'), username: str.default(''), password: str.default('') }),
  z.object({
    type: z.literal('apikey'),
    key: str.default(''),
    value: str.default(''),
    in: z.enum(['header', 'query']).default('header'),
  }),
]);

export const bodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('json'), content: str.default('') }),
  z.object({ type: z.literal('raw'), content: str.default(''), contentType: optStr }),
  z.object({ type: z.literal('urlencoded'), fields: z.array(keyValueSchema).default([]) }),
  z.object({ type: z.literal('form'), fields: z.array(formFieldSchema).default([]) }),
  z.object({ type: z.literal('binary'), filePath: str.default('') }),
]);

const methodSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  z.enum(REQUEST_METHODS),
);

export const requestFileSchema = z.object({
  name: str.optional(),
  method: methodSchema.default('GET'),
  url: str.default(''),
  params: z.array(keyValueSchema).default([]),
  headers: z.array(keyValueSchema).default([]),
  auth: authSchema.default({ type: 'inherit' }),
  body: bodySchema.default({ type: 'none' }),
  docs: optStr,
  order: z.number().optional(),
});

export const folderFileSchema = z.object({
  name: str.optional(),
  auth: authSchema.default({ type: 'inherit' }),
  variables: z.array(variableSchema).default([]),
  docs: optStr,
  order: z.number().optional(),
});

export const scanConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().default(10),
  exclude: z.array(z.string()).default([]),
});

export const configFileSchema = z.object({
  version: z.literal(1).default(1),
  name: str.optional(),
  auth: authSchema.default({ type: 'none' }),
  variables: z.array(variableSchema).default([]),
  docs: optStr,
  scan: scanConfigSchema.optional(),
});

/** .on_route/scan.json: endpoint keys ("GET /users/:") the scanner has already handled. */
export const scanStateFileSchema = z.object({
  version: z.literal(1).default(1),
  known: z.array(z.string()).default([]),
});

export const environmentFileSchema = z.object({
  commit: z.boolean().optional(),
  variables: z.array(variableSchema).default([]),
});

/** .on_route/variables.local.yaml: locked project variables, with their position in the full list. */
export const localVariablesFileSchema = z.object({
  variables: z.array(variableSchema.extend({ position: z.number().optional() })).default([]),
});

// ---------- Normalization helpers ----------

/** Removes keys whose value is undefined (zod / spreads can leave them). */
export function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ---------- Serializers (model -> ordered plain object, defaults omitted) ----------

type Obj = Record<string, unknown>;

export function serializeKeyValue(kv: KeyValue | FormField): Obj {
  const o: Obj = { key: kv.key, value: kv.value };
  if (kv.enabled === false) o.enabled = false;
  if ('kind' in kv && kv.kind === 'file') o.kind = 'file';
  if (kv.description !== undefined) o.description = kv.description;
  return o;
}

export function serializeVariable(v: Variable, blankSecret = false): Obj {
  const o: Obj = { key: v.key, value: blankSecret && v.secret ? '' : v.value };
  if (v.enabled === false) o.enabled = false;
  if (v.secret) o.secret = true;
  if (v.description !== undefined) o.description = v.description;
  return o;
}

export function serializeAuth(a: AuthConfig): Obj {
  switch (a.type) {
    case 'inherit':
    case 'none':
      return { type: a.type };
    case 'bearer':
      return { type: a.type, token: a.token };
    case 'basic':
      return { type: a.type, username: a.username, password: a.password };
    case 'apikey':
      return { type: a.type, key: a.key, value: a.value, in: a.in };
  }
}

export function serializeBody(b: BodyConfig): Obj {
  switch (b.type) {
    case 'none':
      return { type: b.type };
    case 'json':
      return { type: b.type, content: b.content };
    case 'raw': {
      const o: Obj = { type: b.type };
      if (b.contentType !== undefined) o.contentType = b.contentType;
      o.content = b.content;
      return o;
    }
    case 'urlencoded':
    case 'form':
      return { type: b.type, fields: b.fields.map(serializeKeyValue) };
    case 'binary':
      return { type: b.type, filePath: b.filePath };
  }
}

export function serializeRequest(r: RequestDef): Obj {
  const o: Obj = { name: r.name, method: r.method, url: r.url };
  if (r.params.length) o.params = r.params.map(serializeKeyValue);
  if (r.headers.length) o.headers = r.headers.map(serializeKeyValue);
  if (r.auth.type !== 'inherit') o.auth = serializeAuth(r.auth);
  if (r.body.type !== 'none') o.body = serializeBody(r.body);
  if (r.docs !== undefined) o.docs = r.docs;
  if (r.order !== undefined) o.order = r.order;
  return o;
}

export function serializeFolder(f: FolderDef): Obj {
  const o: Obj = { name: f.name };
  if (f.auth.type !== 'inherit') o.auth = serializeAuth(f.auth);
  if (f.variables.length) o.variables = f.variables.map((v) => serializeVariable(v));
  if (f.docs !== undefined) o.docs = f.docs;
  if (f.order !== undefined) o.order = f.order;
  return o;
}

export function serializeConfig(c: ProjectConfig): Obj {
  const o: Obj = {
    version: 1,
    name: c.name,
    auth: serializeAuth(c.auth),
    variables: c.variables.map((v) => serializeVariable(v)),
  };
  if (c.docs !== undefined) o.docs = c.docs;
  if (c.scan) {
    const scan: Obj = { enabled: c.scan.enabled, intervalMinutes: c.scan.intervalMinutes };
    if (c.scan.exclude?.length) scan.exclude = c.scan.exclude;
    o.scan = scan;
  }
  return o;
}

export function serializeEnvironment(env: Environment | { variables: Variable[] }, blankSecrets: boolean): Obj {
  const o: Obj = {};
  if ('commit' in env && env.commit) o.commit = true;
  o.variables = env.variables.map((v) => serializeVariable(v, blankSecrets));
  return o;
}

// ---------- Parsed file -> model ----------

type RequestFile = z.output<typeof requestFileSchema>;
type FolderFile = z.output<typeof folderFileSchema>;
type ConfigFile = z.output<typeof configFileSchema>;

const normKv = <T extends KeyValue>(kv: T): T => stripUndefined(kv);

function normBody(b: BodyConfig): BodyConfig {
  if (b.type === 'urlencoded') return { type: b.type, fields: b.fields.map(normKv) };
  if (b.type === 'form') return { type: b.type, fields: b.fields.map(normKv) };
  return stripUndefined(b);
}

export function requestFromFile(id: string, f: RequestFile): RequestDef {
  const base = id.split('/').pop() ?? id;
  return stripUndefined({
    id,
    name: f.name ?? base,
    method: f.method,
    url: f.url,
    params: f.params.map(normKv),
    headers: f.headers.map(normKv),
    auth: f.auth as AuthConfig,
    body: normBody(f.body as BodyConfig),
    docs: f.docs,
    order: f.order,
  });
}

export function folderFromFile(id: string, f: FolderFile): FolderDef {
  const base = id.split('/').pop() ?? id;
  return stripUndefined({
    id,
    name: f.name ?? base,
    auth: f.auth as AuthConfig,
    variables: f.variables.map((v) => stripUndefined(v)),
    docs: f.docs,
    order: f.order,
  });
}

export function configFromFile(defaultName: string, f: ConfigFile): ProjectConfig {
  return stripUndefined({
    version: 1 as const,
    name: f.name ?? defaultName,
    auth: f.auth as AuthConfig,
    variables: f.variables.map((v) => stripUndefined(v)),
    docs: f.docs,
    scan: f.scan,
  });
}
