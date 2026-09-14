// Endpoint scanning settings, shared by the extension host and the overview page.

/** Stored in on_route.json under `scan`. */
export interface ScanConfig {
  /** Scan on startup, on init and every `intervalMinutes`. Default true. */
  enabled: boolean;
  intervalMinutes: number;
  /** Globs (relative to the workspace root) that are never scanned, e.g. "legacy/**". */
  exclude: string[];
}

export const SCAN_INTERVAL_MIN = 1;
export const SCAN_INTERVAL_MAX = 24 * 60;

export const DEFAULT_SCAN_CONFIG: ScanConfig = { enabled: true, intervalMinutes: 10, exclude: [] };

/** Effective settings: defaults for a missing `scan` block, interval clamped to a sane range. */
export function scanSettings(config: { scan?: Partial<ScanConfig> }): ScanConfig {
  const s = config.scan ?? {};
  const n = Number(s.intervalMinutes);
  return {
    enabled: s.enabled ?? DEFAULT_SCAN_CONFIG.enabled,
    intervalMinutes: Number.isFinite(n) ? Math.min(SCAN_INTERVAL_MAX, Math.max(SCAN_INTERVAL_MIN, Math.round(n))) : DEFAULT_SCAN_CONFIG.intervalMinutes,
    exclude: Array.isArray(s.exclude) ? s.exclude.filter((g) => typeof g === 'string' && g.trim() !== '') : [],
  };
}

/** Frameworks whose routes the scanner understands, grouped by language for display. */
export const SCAN_FRAMEWORK_GROUPS = [
  { language: 'JavaScript / TypeScript', frameworks: ['Express', 'Fastify', 'Hono', 'Koa', 'Elysia', 'NestJS', 'Next.js'] },
  { language: 'Python', frameworks: ['FastAPI', 'Flask', 'Django'] },
  { language: 'Go', frameworks: ['Gin', 'Echo', 'Fiber', 'Chi', 'Gorilla Mux', 'net/http'] },
  { language: 'Java / Kotlin', frameworks: ['Spring'] },
  { language: 'PHP', frameworks: ['Laravel'] },
  { language: 'Ruby', frameworks: ['Rails'] },
] as const;

export type Framework = (typeof SCAN_FRAMEWORK_GROUPS)[number]['frameworks'][number];
