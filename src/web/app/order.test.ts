import { describe, expect, it } from 'vitest';
import { applyOrder, dropIndex, fullOrder, moveBy, moveItem, sameOrder, sortByOrder } from './order';

const p = (id: string, order: number) => ({ id, order });

describe('sortByOrder', () => {
  it('sorts by dashboard position and keeps ties in their incoming order', () => {
    expect(sortByOrder([p('c', 2), p('a', 0), p('b', 1), p('d', 1)]).map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('does not change the list it was given', () => {
    const list = [p('b', 1), p('a', 0)];
    sortByOrder(list);
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('moveItem and moveBy', () => {
  it('moves an item down and up', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('clamps the target and ignores a missing source', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, -5)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 7, 0)).toEqual(['a', 'b']);
  });

  it('moves by a number of places, staying in the list', () => {
    expect(moveBy(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b'], 'zz', 1)).toEqual(['a', 'b']);
  });
});

describe('applyOrder', () => {
  const pills = [p('a', 0), p('b', 1), p('c', 2)];

  it('uses the hub order without a local one', () => {
    expect(applyOrder([p('b', 1), p('a', 0)], null).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('follows a local order, putting newly added pills last and ignoring gone ones', () => {
    expect(applyOrder([...pills, p('new', 3)], ['c', 'gone', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'a', 'b', 'new']);
  });
});

describe('dropIndex', () => {
  it('counts the rows whose middle is above the dragged row', () => {
    const middles = [25, 85, 145];
    expect(dropIndex(middles, 10)).toBe(0);
    expect(dropIndex(middles, 26)).toBe(1);
    expect(dropIndex(middles, 200)).toBe(3);
  });
});

describe('fullOrder', () => {
  it('appends the pills that were not arranged (archived ones) in their own order', () => {
    const all = [p('a', 0), p('arch2', 5), p('b', 1), p('arch1', 4)];
    expect(fullOrder(['b', 'a'], all)).toEqual(['b', 'a', 'arch1', 'arch2']);
  });
});

describe('sameOrder', () => {
  it('compares lists item by item', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});
