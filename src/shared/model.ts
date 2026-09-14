// Core data model shared by extension host and webview.
// Files on disk (YAML) map 1:1 to these types, minus the derived `id` fields.
import { DEFAULT_SCAN_CONFIG, type ScanConfig } from './scan';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Method choices of a saved request: HTTP methods plus `WS`, a WebSocket connection (handshake is a GET). */
export const REQUEST_METHODS = [...HTTP_METHODS, 'WS'] as const;
export type RequestMethod = (typeof REQUEST_METHODS)[number];

export const isWebSocket = (method: RequestMethod | undefined): method is 'WS' => method === 'WS';

export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean; // default true
  description?: string;
}

export interface Variable {
  key: string;
  value: string;
  enabled?: boolean; // default true
  /** Secret: committed value is ignored; real value comes from local override file / SecretStorage. */
  secret?: boolean;
  description?: string;
}

export type AuthConfig =
  | { type: 'inherit' }
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' };

export interface FormField extends KeyValue {
  kind?: 'text' | 'file'; // default text; file => value is a path relative to workspace root
}

export type BodyConfig =
  | { type: 'none' }
  | { type: 'json'; content: string }
  | { type: 'raw'; content: string; contentType?: string }
  | { type: 'urlencoded'; fields: KeyValue[] }
  | { type: 'form'; fields: FormField[] }
  | { type: 'binary'; filePath: string };

/** A saved request. File: .on_route/requests/<id>.yaml */
export interface RequestDef {
  /** Path relative to requests/ without extension, POSIX separators. e.g. "users/get-user". Not stored in file. */
  id: string;
  name: string;
  method: RequestMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  auth: AuthConfig;
  body: BodyConfig;
  docs?: string;
  order?: number;
}

/** A folder. Optional file: .on_route/requests/<id>/_folder.yaml */
export interface FolderDef {
  /** Path relative to requests/, POSIX. "" never used (root settings live in ProjectConfig). Not stored in file. */
  id: string;
  name: string; // defaults to directory name
  auth: AuthConfig; // default inherit
  variables: Variable[];
  docs?: string;
  order?: number;
}

/** File: .on_route/on_route.json */
export interface ProjectConfig {
  version: 1;
  name: string;
  auth: AuthConfig; // default none
  variables: Variable[]; // collection variables, e.g. baseUrl
  docs?: string;
  /** Endpoint scanning; missing = defaults (see scanSettings). */
  scan?: ScanConfig;
}

/** File: .on_route/environments/<name>.yaml ; local overrides in <name>.local.yaml (gitignored) */
export interface Environment {
  name: string; // derived from file name
  variables: Variable[];
  /** Commit environments/<name>.yaml to git. Default false: the file is listed in .on_route/.gitignore. */
  commit?: boolean;
}

export interface RequestSummary {
  id: string;
  folderId: string; // "" for top level
  name: string;
  method: RequestMethod;
  url: string;
  order?: number;
}

export interface LoadError {
  file: string; // path relative to workspace root
  message: string;
  line?: number; // 1-based
}

export interface ProjectTree {
  config: ProjectConfig;
  folders: FolderDef[]; // all folders, any depth
  requests: RequestSummary[];
  environments: Environment[];
  errors: LoadError[];
}

// ---------- Resolved (variables substituted, auth applied) ----------

export type ResolvedBody =
  | { type: 'none' }
  | { type: 'text'; content: string; contentType?: string }
  | { type: 'urlencoded'; fields: { key: string; value: string }[] }
  | { type: 'form'; fields: { key: string; value: string; kind: 'text' | 'file' }[] }
  | { type: 'binary'; filePath: string };

export interface ResolvedRequest {
  method: HttpMethod;
  /** Full URL including enabled query params. */
  url: string;
  /** Enabled headers only, in order. Includes auth + inferred Content-Type. */
  headers: { key: string; value: string }[];
  body: ResolvedBody;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** Bytes received. */
  size: number;
  timing: { totalMs: number; ttfbMs?: number };
  contentType?: string;
  truncated?: boolean;
  /**
   * History only: the body was binary and too large to keep, so it was dropped rather than cut in half.
   * Half a media file plays badly or not at all, so none of it is kept.
   */
  bodyOmitted?: boolean;
}

export interface HttpErrorInfo {
  message: string;
  code?: string;
  timing: { totalMs: number };
}

export interface HistoryEntry {
  id: string;
  requestId: string;
  timestamp: number; // epoch ms
  environment: string | null;
  request: ResolvedRequest;
  response?: HttpResponse;
  error?: HttpErrorInfo;
}

// ---------- Defaults ----------

export function newRequest(id: string, name: string): RequestDef {
  return {
    id,
    name,
    method: 'GET',
    url: '{{baseUrl}}/',
    params: [],
    headers: [],
    auth: { type: 'inherit' },
    body: { type: 'none' },
  };
}

export function defaultProjectConfig(name: string): ProjectConfig {
  return {
    version: 1,
    name,
    auth: { type: 'none' },
    variables: [{ key: 'baseUrl', value: 'http://localhost:3000' }],
    scan: { ...DEFAULT_SCAN_CONFIG },
  };
}

export const isEnabled = (x: { enabled?: boolean }) => x.enabled !== false;
