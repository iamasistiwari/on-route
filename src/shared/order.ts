// Manual ordering of requests and folders (the `order` field), shared by the extension host and the webview.

/** Explicit order first (missing = after every ordered item), then name. */
export function byOrder<T extends { order?: number; name: string }>(a: T, b: T): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.order ?? Number.MAX_SAFE_INTEGER;
  return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
}

/** `ids` with `id` moved in front of `before` (null or not found = to the end). `id` may be missing from `ids`. */
export function placeBefore(ids: readonly string[], id: string, before: string | null): string[] {
  const out = ids.filter((x) => x !== id);
  const at = before === null ? -1 : out.indexOf(before);
  if (at < 0) out.push(id);
  else out.splice(at, 0, id);
  return out;
}

/**
 * New `order` values (0, 1, 2, …) for a folder's siblings after placing `id` before `before`. Only entries
 * whose stored order changes are returned, so an already ordered folder rewrites as few files as possible.
 */
export function orderUpdates(
  siblings: readonly { id: string; name: string; order?: number }[],
  id: string,
  before: string | null,
): { id: string; order: number }[] {
  const current = new Map(siblings.map((s) => [s.id, s.order]));
  const sorted = [...siblings].sort(byOrder).map((s) => s.id);
  return placeBefore(sorted, id, before)
    .map((sid, order) => ({ id: sid, order }))
    .filter((u) => current.get(u.id) !== u.order);
}

/**
 * Order for items appended to a folder: after the last sibling when the user has arranged the folder (every
 * sibling has an order), otherwise undefined so the folder stays alphabetical.
 */
export function appendOrder(siblings: readonly { order?: number }[]): number | undefined {
  if (!siblings.length || siblings.some((s) => s.order === undefined)) return undefined;
  return Math.max(...siblings.map((s) => s.order!)) + 1;
}
