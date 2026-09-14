import type { HttpMethod } from '../../shared/model';
import type { Framework } from '../../shared/scan';

export type { Framework };

/** A source file, `path` relative to the scan root with POSIX separators. */
export interface SourceFile {
  path: string;
  text: string;
}

export interface ScannedRoute {
  method: HttpMethod;
  /** Full path with every mount prefix applied; params as `:name`. */
  path: string;
  framework: Framework;
  file: string;
  /** 1-based line of the route definition. */
  line: number;
}

/** Project-wide facts language scanners use to decide how strict to be. */
export interface ProjectHints {
  /** npm dependency names from every package.json in the workspace. */
  npmDependencies: ReadonlySet<string>;
}
