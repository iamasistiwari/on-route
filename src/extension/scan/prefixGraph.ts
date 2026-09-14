// Mount-prefix resolution: routers mounted under prefixes, possibly across files and several levels deep.
import { joinPath } from './paths';

interface Edge {
  parent: string;
  prefix: string;
  /** The mount prefix replaces the child's own prefix (Flask register_blueprint url_prefix). */
  replaceOwn: boolean;
}

const MAX_DEPTH = 24;

/**
 * Nodes are router objects, keyed `file#name@scope`. `file#*@0` stands for "every router in the file"
 * (used when a whole module is mounted); it applies to routers that have no explicit mount of their own.
 */
export class PrefixGraph {
  private readonly own = new Map<string, string>();
  private readonly edges = new Map<string, Edge[]>();

  constructor(private readonly keepTrailingSlash = false) {}

  static node(file: string, name = '*', scope = 0): string {
    return `${file}#${name}@${scope}`;
  }

  /** Prefix a router applies to its own routes (APIRouter(prefix=...), new Router({ prefix })). */
  setOwn(node: string, prefix: string): void {
    this.own.set(node, prefix);
  }

  addEdge(child: string, parent: string, prefix: string, replaceOwn = false): void {
    if (child === parent) return;
    const list = this.edges.get(child) ?? [];
    if (!list.some((e) => e.parent === parent && e.prefix === prefix)) list.push({ parent, prefix, replaceOwn });
    this.edges.set(child, list);
  }

  hasIncoming(node: string): boolean {
    return (this.edges.get(node)?.length ?? 0) > 0;
  }

  /** Every full prefix a router is reachable under (one per distinct mount chain). */
  prefixes(node: string): string[] {
    return this.resolve(node, new Set());
  }

  private resolve(node: string, seen: Set<string>): string[] {
    const own = this.own.get(node) ?? '';
    if (seen.has(node) || seen.size > MAX_DEPTH) return [joinPath([own], this.keepTrailingSlash)];
    const next = new Set(seen).add(node);
    let incoming = this.edges.get(node) ?? [];
    if (!incoming.length) {
      const wildcard = `${node.slice(0, node.indexOf('#'))}#*@0`;
      if (wildcard !== node) incoming = this.edges.get(wildcard) ?? [];
    }
    if (!incoming.length) return [joinPath([own], this.keepTrailingSlash)];
    const out = new Set<string>();
    for (const e of incoming) {
      for (const p of this.resolve(e.parent, next)) out.add(joinPath([p, e.prefix, e.replaceOwn ? '' : own], this.keepTrailingSlash));
    }
    return [...out];
  }
}
