/** Helpers for putting pills in the owner's order on the dashboard. */

export interface Ordered {
  id: string;
  order: number;
}

/** Sorted by dashboard position, keeping the incoming order for ties. */
export function sortByOrder<T extends Ordered>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.order - b.item.order || a.i - b.i)
    .map((x) => x.item);
}

/** `ids` with the item at `from` moved to `to` (both clamped to the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

/** `ids` with `id` moved by `delta` places (−1 is up). */
export function moveBy(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  return from === -1 ? [...ids] : moveItem(ids, from, from + delta);
}

/**
 * Items in the order of `ids` (a local, unsaved order). Items missing from `ids` (added meanwhile) go last, by their
 * own order; ids of items that have gone are ignored.
 */
export function applyOrder<T extends Ordered>(items: readonly T[], ids: readonly string[] | null): T[] {
  const sorted = sortByOrder(items);
  if (!ids) return sorted;
  const rank = new Map(ids.map((id, i) => [id, i]));
  return sorted
    .map((item, i) => ({ item, r: rank.get(item.id) ?? ids.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.item);
}

/**
 * Where a dragged row belongs: the number of other rows whose middle is above the dragged row's middle.
 * `middles` are the vertical centres of the other rows, top to bottom.
 */
export function dropIndex(middles: readonly number[], draggedMiddle: number): number {
  let i = 0;
  for (const m of middles) if (draggedMiddle > m) i++;
  return i;
}

/** The full order to save: the arranged pills first, then every other pill (archived ones) in their current order. */
export function fullOrder<T extends Ordered>(arranged: readonly string[], all: readonly T[]): string[] {
  const seen = new Set(arranged);
  return [...arranged, ...sortByOrder(all.filter((p) => !seen.has(p.id))).map((p) => p.id)];
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);
