// 布景历史只保存布局；鱼、成长、账号状态始终来自当前存档。
import { cloneState, validate } from './model.js';

export function createDecorHistory({ getScope, limit = 20 }) {
  let scope;
  const entries = [];
  function checkScope() {
    const current = getScope();
    if (current !== scope) { entries.length = 0; scope = current; }
  }
  return {
    get length() { checkScope(); return entries.length; },
    clear() { entries.length = 0; scope = getScope(); },
    discardObject(id, state) {
      checkScope();
      for (const entry of entries) entry.decor = entry.decor.filter(item => item.id !== id);
      const current = JSON.stringify({decor: state.decor, layout: state.layout});
      while (entries.length && JSON.stringify(entries.at(-1)) === current) entries.pop();
    },
    push(state) {
      checkScope();
      entries.push(cloneState({ decor: state.decor, layout: state.layout }));
      if (entries.length > limit) entries.shift();
    },
    restore(state, now = Date.now()) {
      checkScope();
      const previous = entries.pop();
      if (!previous) return null;
      return validate({ ...state, ...previous, savedAt: now }, now);
    }
  };
}
