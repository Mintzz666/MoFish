const clone = (value) => JSON.parse(JSON.stringify(value));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertId(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 100) {
    throw new Error(`${label} ID无效`);
  }
}

function assertUniqueRecords(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label}必须是数组`);
  const ids = new Set();
  for (const item of items) {
    if (!isRecord(item)) throw new Error(`${label}数据不完整`);
    assertId(item.id, label);
    if (ids.has(item.id)) throw new Error(`${label}ID重复`);
    ids.add(item.id);
  }
  return ids;
}

function assertState(state, label = 'state') {
  if (!isRecord(state) || state.version !== 2) throw new Error(`${label}不是有效的v2状态`);
  assertUniqueRecords(state.fish, `${label} fish`);
  assertUniqueRecords(state.decor, `${label} decor`);
  for (const fish of state.fish) {
    if (typeof fish.name !== 'string' || !Number.isFinite(fish.growth) || !Number.isFinite(fish.meals)) {
      throw new Error(`${label} fish数据不完整`);
    }
  }
  if (typeof state.night !== 'boolean') throw new Error(`${label} night必须是布尔值`);
  return state;
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('状态中不能包含非有限数值');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('状态中不能包含循环引用');
    seen.add(value);
    const result = value.map((item) => item === undefined ? null : stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error('状态中不能包含循环引用');
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = stableValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error('状态中包含不可比较的数据');
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function same(a, b) {
  return canonical(a) === canonical(b);
}

function withoutKeys(object, keys) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (!keys.has(key)) result[key] = value;
  }
  return result;
}

const FISH_AUTHORITY_FIELDS = new Set(['growth', 'meals']);
const FISH_MUTABLE_FIELDS = new Set(['name', 'growth', 'meals']);

function fishComparable(fish) {
  return withoutKeys(fish, FISH_AUTHORITY_FIELDS);
}

function fishRemovalSnapshot(fish) {
  return clone(fishComparable(fish));
}

function fishRenameInvariant(fish) {
  return withoutKeys(fish, new Set([...FISH_MUTABLE_FIELDS]));
}

function mapById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function assertNewFish(fish) {
  if (!isRecord(fish) || typeof fish.id !== 'string') throw new Error('新增鱼数据不完整');
  assertId(fish.id, 'fish');
  if (typeof fish.name !== 'string' || !Number.isFinite(fish.growth) || !Number.isFinite(fish.meals)) {
    throw new Error('新增鱼数据不完整');
  }
  if (fish.growth !== 0 || fish.meals !== 0) throw new Error('新增鱼的growth和meals必须为0');
}

function assertDecor(decor, label = 'decor') {
  if (!isRecord(decor)) throw new Error(`${label}数据不完整`);
  assertId(decor.id, label);
}

/**
 * Convert two v2 aquarium snapshots into stable, atomic shared-state operations.
 * Client supplied growth and meal counts are server-owned and therefore ignored
 * for existing fish; new fish must start at zero for both fields.
 */
export function diffSharedState(before, after) {
  assertState(before, 'before');
  assertState(after, 'after');

  const beforeFish = mapById(before.fish);
  const afterFish = mapById(after.fish);
  const beforeDecor = mapById(before.decor);
  const afterDecor = mapById(after.decor);
  const operations = [];

  // Fish operations: removals, then permitted renames, then additions.
  for (const fish of before.fish) {
    const next = afterFish.get(fish.id);
    if (!next) {
      operations.push({ kind: 'fish_remove', id: fish.id, before: fishRemovalSnapshot(fish) });
      continue;
    }
    if (!same(fishRenameInvariant(fish), fishRenameInvariant(next))) {
      throw new Error(`已有鱼 ${fish.id} 除名字外的字段不能修改`);
    }
    if (fish.name !== next.name) {
      operations.push({ kind: 'fish_rename', id: fish.id, before: fish.name, name: next.name });
    }
  }
  for (const fish of after.fish) {
    if (beforeFish.has(fish.id)) continue;
    assertNewFish(fish);
    operations.push({ kind: 'fish_add', fish: clone(fish) });
  }

  // Decor operations: removals, then updates, then additions.
  for (const decor of before.decor) {
    const next = afterDecor.get(decor.id);
    if (!next) {
      operations.push({ kind: 'decor_remove', id: decor.id, before: clone(decor) });
    } else if (!same(decor, next)) {
      operations.push({ kind: 'decor_update', id: decor.id, before: clone(decor), decor: clone(next) });
    }
  }
  for (const decor of after.decor) {
    if (!beforeDecor.has(decor.id)) operations.push({ kind: 'decor_add', decor: clone(decor) });
  }

  if (before.night !== after.night) {
    operations.push({ kind: 'set_night', before: before.night, value: after.night });
  }
  return operations;
}

function operationIsRecord(operation) {
  return isRecord(operation) && typeof operation.kind === 'string';
}

function validateOperation(operation) {
  if (!operationIsRecord(operation)) throw new Error('共享操作格式不正确');
  switch (operation.kind) {
    case 'fish_add':
      assertNewFish(operation.fish);
      break;
    case 'fish_remove':
      assertId(operation.id, 'fish');
      if (!isRecord(operation.before) || operation.before.id !== operation.id) throw new Error('fish_remove before无效');
      assertId(operation.before.id, 'fish');
      if ('growth' in operation.before || 'meals' in operation.before) throw new Error('fish_remove before不能包含growth或meals');
      break;
    case 'fish_rename':
      assertId(operation.id, 'fish');
      if (typeof operation.before !== 'string' || typeof operation.name !== 'string') throw new Error('fish_rename字段无效');
      break;
    case 'decor_add':
      assertDecor(operation.decor, 'decor_add');
      break;
    case 'decor_update':
      assertId(operation.id, 'decor');
      assertDecor(operation.before, 'decor_update before');
      assertDecor(operation.decor, 'decor_update decor');
      if (operation.before.id !== operation.id || operation.decor.id !== operation.id) throw new Error('decor_update ID不一致');
      break;
    case 'decor_remove':
      assertId(operation.id, 'decor');
      assertDecor(operation.before, 'decor_remove before');
      if (operation.before.id !== operation.id) throw new Error('decor_remove ID不一致');
      break;
    case 'set_night':
      if (typeof operation.before !== 'boolean' || typeof operation.value !== 'boolean') throw new Error('set_night字段无效');
      break;
    default:
      throw new Error(`未知共享操作: ${operation.kind}`);
  }
}

function conflict(state) {
  return { ok: false, conflict: true, state: clone(state) };
}

/**
 * Apply shared operations to a snapshot without mutating the caller's state.
 * Strict mode checks every before value; relaxed mode projects the intended
 * changes onto matching objects and skips operations whose targets disappeared.
 */
export function applySharedOperations(state, operations, { strict = true } = {}) {
  assertState(state);
  if (!Array.isArray(operations)) throw new Error('operations必须是数组');
  if (typeof strict !== 'boolean') throw new Error('strict必须是布尔值');
  for (const operation of operations) validateOperation(operation);

  const original = clone(state);
  const next = clone(state);
  for (const operation of operations) {
    switch (operation.kind) {
      case 'fish_add': {
        const index = next.fish.findIndex((fish) => fish.id === operation.fish.id);
        if (index >= 0) {
          if (same(fishComparable(next.fish[index]), fishComparable(operation.fish))) continue;
          return conflict(original);
        }
        next.fish.push(clone(operation.fish));
        break;
      }
      case 'fish_remove': {
        const index = next.fish.findIndex((fish) => fish.id === operation.id);
        if (index < 0) {
          if (strict) return conflict(original);
          break;
        }
        if (strict && !same(fishRemovalSnapshot(next.fish[index]), operation.before)) return conflict(original);
        next.fish.splice(index, 1);
        break;
      }
      case 'fish_rename': {
        const fish = next.fish.find((item) => item.id === operation.id);
        if (!fish) {
          if (strict) return conflict(original);
          break;
        }
        if (strict && fish.name !== operation.before) return conflict(original);
        fish.name = operation.name;
        break;
      }
      case 'decor_add': {
        const index = next.decor.findIndex((decor) => decor.id === operation.decor.id);
        if (index >= 0) {
          if (same(next.decor[index], operation.decor)) continue;
          return conflict(original);
        }
        next.decor.push(clone(operation.decor));
        break;
      }
      case 'decor_update': {
        const index = next.decor.findIndex((decor) => decor.id === operation.id);
        if (index < 0) {
          if (strict) return conflict(original);
          break;
        }
        if (strict && !same(next.decor[index], operation.before)) return conflict(original);
        next.decor[index] = clone(operation.decor);
        break;
      }
      case 'decor_remove': {
        const index = next.decor.findIndex((decor) => decor.id === operation.id);
        if (index < 0) {
          if (strict) return conflict(original);
          break;
        }
        if (strict && !same(next.decor[index], operation.before)) return conflict(original);
        next.decor.splice(index, 1);
        break;
      }
      case 'set_night':
        if (strict && next.night !== operation.before) return conflict(original);
        next.night = operation.value;
        break;
      default:
        // validateOperation has already rejected unsupported operation kinds.
        throw new Error(`未知共享操作: ${operation.kind}`);
    }
  }
  assertState(next, 'result');
  return { ok: true, state: next };
}
