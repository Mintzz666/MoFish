// 测试用的内存 Storage（实现 localStorage 的最小接口）。
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    /** 测试辅助：直接看底层键，确认没有写错命名空间。 */
    rawKeys() { return Array.from(map.keys()).sort(); },
    snapshot() { return Object.fromEntries(map.entries()); }
  };
}
