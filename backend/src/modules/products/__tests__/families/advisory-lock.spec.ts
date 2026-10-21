import {
  fnv1a32,
  sortLockKeys,
  storePublicationLock,
  productFamilyLock,
  LOCK_NS_STORE_PUBLICATION,
  LOCK_NS_PRODUCT_FAMILY,
} from '../../families/advisory-lock.util';

/**
 * Lock identity must never drift.
 *
 * These keys decide which transactions serialize against each other. If the
 * hash changed — a different multiply, a different signed fold, a different
 * byte encoding — two deployments would compute different keys for the same
 * store and stop serializing at all, silently. The invariant would then fail
 * only under concurrency, which is exactly where nobody is watching.
 *
 * Hence fixed vectors rather than round-trip properties.
 */
describe('advisory lock keys', () => {
  describe('fnv1a32 fixed vectors', () => {
    // Canonical FNV-1a 32-bit values, folded to signed int32.
    it.each([
      ['', 2166136261 | 0],
      ['a', 0xe40c292c | 0],
      ['foobar', 0xbf9cf968 | 0],
    ])('hashes %p to the canonical value', (input, expected) => {
      expect(fnv1a32(input as string)).toBe(expected);
    });

    it('returns a signed int32 for a UUID, as int4 requires', () => {
      const h = fnv1a32('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(-2147483648);
      expect(h).toBeLessThanOrEqual(2147483647);
      expect(h | 0).toBe(h);
    });

    it('is deterministic across calls', () => {
      const id = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
      expect(fnv1a32(id)).toBe(fnv1a32(id));
    });

    it('encodes multi-byte characters as UTF-8, not UTF-16 code units', () => {
      // 'é' is ONE UTF-16 code unit but TWO UTF-8 bytes (0xC3 0xA9). An
      // implementation hashing code units agrees with this one on all ASCII
      // and diverges only here — so this fixed vector is the test, and the
      // byte-length check below is supporting evidence for why.
      expect(fnv1a32('é')).toBe(0x1e9de8c1 | 0);
      expect(new TextEncoder().encode('é')).toHaveLength(2);
    });
  });

  describe('namespaces', () => {
    it('separates a store publication lock from a family lock of the same id', () => {
      const id = 'same-id';
      const store = storePublicationLock(id);
      const family = productFamilyLock(id);
      expect(store.ns).toBe(LOCK_NS_STORE_PUBLICATION);
      expect(family.ns).toBe(LOCK_NS_PRODUCT_FAMILY);
      expect(store.key).toBe(family.key); // same hash …
      expect(store.ns).not.toBe(family.ns); // … but different locks
    });

    it("takes a standalone product's own id as its family root", () => {
      // A product with no parent IS its own family root, so two operations on
      // the same standalone product serialize exactly as two operations on the
      // same family do. Without this the childless case would take no family
      // lock at all and the shape-transition race would reopen.
      const standaloneId = 'e6f1a2b3-0000-4000-8000-000000000001';
      expect(productFamilyLock(standaloneId)).toEqual({
        ns: LOCK_NS_PRODUCT_FAMILY,
        key: fnv1a32(standaloneId),
      });
    });
  });

  describe('sortLockKeys', () => {
    it('orders by namespace, then by signed key ascending', () => {
      const sorted = sortLockKeys([
        { ns: 2, key: -5 },
        { ns: 1, key: 10 },
        { ns: 2, key: -100 },
        { ns: 1, key: -1 },
      ]);
      expect(sorted).toEqual([
        { ns: 1, key: -1 },
        { ns: 1, key: 10 },
        { ns: 2, key: -100 },
        { ns: 2, key: -5 },
      ]);
    });

    it('sorts negatives numerically, not lexicographically', () => {
      // A string sort would put -2147483648 after -1 and break the total order.
      const sorted = sortLockKeys([
        { ns: 1, key: -1 },
        { ns: 1, key: -2147483648 },
      ]);
      expect(sorted.map((k) => k.key)).toEqual([-2147483648, -1]);
    });

    it('de-duplicates, so a store named twice is locked once', () => {
      const k = storePublicationLock('store-1');
      expect(sortLockKeys([k, { ...k }, k])).toEqual([k]);
    });

    it('produces the same order regardless of input order', () => {
      const a = storePublicationLock('store-a');
      const b = storePublicationLock('store-b');
      const f = productFamilyLock('prod-1');
      expect(sortLockKeys([a, b, f])).toEqual(sortLockKeys([f, b, a]));
    });

    it('returns an empty list unchanged', () => {
      expect(sortLockKeys([])).toEqual([]);
    });
  });
});
