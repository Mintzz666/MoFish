import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initial, validate, catchUp, eat, createStorage, makeFish, stageOf, ageDays,
  fishAppearance, decorAppearance, GROWTH, STAGES, STATE_VERSION, LOOK_VERSION,
  addDecor, removeDecor, reshuffleDecor, updateDecor, clampTransform, canonicalState,
  DECOR_KINDS, DECOR_MAX, hashSeed, mulberry32
} from '../web/model.js';

// ------------------------------------------------------------------ 旧档迁移

const legacyV1 = (over = {}) => ({
  version: 1,
  fish: [
    { id: 'old-a', name: '老满', species: 0, born: 1000, growth: 0.82, meals: 12 },
    { id: 'old-b', name: '老青', species: 1, born: 2000, growth: 0.2, meals: 3, extra: 'drop-me' }
  ],
  plants: 3,
  night: true,
  sound: false,
  savedAt: 5000,
  ...over
});

test('v1 存档无损升级：鱼 id/名字/成长/进食保留，种类语义映射到新类型', () => {
  const upgraded = validate(legacyV1(), 1_000_000);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.fish.length, 2);
  assert.equal(upgraded.fish[0].id, 'old-a');
  assert.equal(upgraded.fish[0].name, '老满');
  assert.equal(upgraded.fish[0].growth, 0.82, '旧成年鱼不会因新增阶段被重置');
  assert.equal(upgraded.fish[0].meals, 12);
  assert.equal(upgraded.fish[0].species, 'sunset', '旧 species=0 映射到落日金');
  assert.equal(upgraded.fish[1].species, 'mint');
  assert.equal(upgraded.fish[1].extra, undefined, '外来字段会被丢弃');
  assert.equal(upgraded.night, true);
  assert.equal(upgraded.sound, false);
});

test('旧 plants 数量稳定迁移成水草对象，反复升级得到同一批水草', () => {
  const once = validate(legacyV1(), 1_000_000);
  const twice = validate(legacyV1(), 1_000_000);
  assert.equal(once.decor.length, 3);
  assert.ok(once.decor.every((d) => d.kind === 'plant'));
  assert.deepEqual(once.decor, twice.decor, '迁移必须确定性：不能每次刷新换一批造型');
  assert.deepEqual(once.fish, twice.fish);
  assert.ok(once.decor.every((d) => d.x >= 0 && d.x <= 1 && d.z >= 0 && d.z <= 1));
  assert.ok(once.decor.every((d) => Number.isInteger(d.seed)));
});

test('旧鱼没有外观种子时按 id 哈希生成，刷新后仍是同一副样子', () => {
  const a = validate(legacyV1(), 1_000_000);
  const b = validate(legacyV1(), 2_000_000);
  assert.equal(a.fish[0].look.seed, b.fish[0].look.seed);
  assert.equal(a.fish[0].look.v, LOOK_VERSION);
  assert.equal(a.fish[0].look.seed, hashSeed('fish:old-a'));
});

// ------------------------------------------------------------------ 四阶段成长

test('四阶段阈值固定为 0.15 / 0.4 / 0.7，旧成年鱼仍处于成年期', () => {
  assert.deepEqual(STAGES.map((s) => s.min), [0, 0.15, 0.4, 0.7]);
  assert.equal(stageOf(0).key, 'fry');
  assert.equal(stageOf(0.149).key, 'fry');
  assert.equal(stageOf(0.15).key, 'juvenile');
  assert.equal(stageOf(0.399).key, 'juvenile');
  assert.equal(stageOf(0.4).key, 'subadult');
  assert.equal(stageOf(0.699).key, 'subadult');
  assert.equal(stageOf(0.7).key, 'adult');
  assert.equal(stageOf(0.82).key, 'adult');
});

test('时间成长：0.05/24h，离线最多结算 24 小时且不重复', () => {
  const state = initial(1000);
  const hours = catchUp(state, 1000 + 72 * 3600000);
  assert.equal(hours, 24);
  assert.ok(Math.abs(state.fish[0].growth - 0.05) < 1e-9);
  const again = catchUp(state, 1000 + 72 * 3600000);
  assert.equal(again, 0);
  assert.ok(Math.abs(state.fish[0].growth - 0.05) < 1e-9);
});

test('默认周期：自然约 14 天成年，正常进食约 10 天（0.05 + 0.02 每天）', () => {
  assert.equal(Math.round(0.7 / GROWTH.naturalPerDay), 14);
  assert.equal(Math.round(0.7 / (GROWTH.naturalPerDay + GROWTH.nutritionPerDay)), 10);
});

test('进食按「真的吃到」记账：每口 +0.00667，滚动 24h 最多 3 口计入成长', () => {
  const fish = makeFish(0, 0, { species: 'sunset' });
  const now = 1_700_000_000_000;
  const first = eat(fish, now);
  assert.equal(first.credited, true);
  assert.equal(fish.meals, 1);
  assert.ok(Math.abs(fish.growth - GROWTH.biteGrowth) < 1e-9);
  eat(fish, now + 1000);
  eat(fish, now + 2000);
  const overflow = eat(fish, now + 3000);
  assert.equal(overflow.credited, false, '第 4 口不再加速成长');
  assert.equal(overflow.remaining, 0);
  assert.equal(fish.meals, 4, '吃饱了仍然记录互动次数');
  assert.ok(Math.abs(fish.growth - GROWTH.biteGrowth * 3) < 1e-9);
  // 24 小时后再吃，重新获得营养额度
  const nextDay = eat(fish, now + 86400000 + 10);
  assert.equal(nextDay.credited, true);
});

test('游客模式的营养窗口持久化在 fedAt 里，刷新不会重复计入同一口', () => {
  const fish = makeFish(0, 0, { species: 'mint' });
  const now = 1_700_000_000_000;
  eat(fish, now);
  const state = validate({ ...initial(now), fish: [fish] }, now + 1000);
  assert.equal(state.fish[0].fedAt.length, 1);
  assert.ok(Math.abs(state.fish[0].growth - GROWTH.biteGrowth) < 1e-9);
});

test('成长封顶 1.0，鱼龄与成长阶段是两个独立字段', () => {
  const fish = makeFish(0, 0, { species: 'fan' });
  fish.growth = 0.999;
  for (let i = 0; i < 30; i += 1) eat(fish, i * 3600001);
  assert.equal(fish.growth, 1);
  assert.equal(fish.meals, 30);
  assert.equal(Math.round(ageDays(0, 10 * 86400000)), 10);
});

// ------------------------------------------------------------------ 外观（持久 seed）

test('同一条鱼的随机外观由 seed 决定，重复读取完全一致', () => {
  const fish = makeFish(0, 0, { species: 'coral', seed: 424242 });
  const a = fishAppearance(fish);
  const b = fishAppearance(JSON.parse(JSON.stringify(fish)));
  assert.deepEqual(a, b);
  assert.equal(a.typeId, 'coral');
  assert.ok(a.body.startsWith('#') && a.fin.startsWith('#'));
  const other = fishAppearance(makeFish(0, 0, { species: 'coral', seed: 99 }));
  assert.notEqual(a.body, other.body, '同种鱼的不同个体应有不同配色');
  assert.equal(other.typeId, 'coral');
});

test('成长让颜色更饱和、体型更大，但不会重掷外观', () => {
  const fry = validate({ ...initial(0), fish: [makeFish(0, 0, { species: 'dart', seed: 7 })] }, 1000).fish[0];
  const adultFish = validate({ ...initial(0), fish: [makeFish(0, 0, { species: 'dart', seed: 7 })] }, 1000).fish[0];
  adultFish.growth = 0.9;
  const young = fishAppearance(fry);
  const adult = fishAppearance(adultFish);
  assert.equal(young.pattern, adult.pattern, '花纹不会因为成长而重掷');
  assert.ok(adult.props.size > young.props.size);
  assert.ok(adult.props.vivid > young.props.vivid);
});

test('造景个体参数由 seed 决定，换 seed 只换造型', () => {
  const a = decorAppearance('rock', 'seiryu', 11);
  const b = decorAppearance('rock', 'seiryu', 11);
  const c = decorAppearance('rock', 'seiryu', 12);
  assert.deepEqual(a, b);
  assert.notEqual(a.params.size, c.params.size);
  assert.equal(a.kind, 'rock');
});

test('九种鱼型 / 六类水草 / 五类石头 / 两类沉木的目录齐备', async () => {
  const catalog = await import('../web/catalog.js');
  assert.ok(catalog.FISH_TYPES.length >= 8, `鱼型至少 8 种，实际 ${catalog.FISH_TYPES.length}`);
  assert.equal(new Set(catalog.FISH_TYPES.map((t) => t.id)).size, catalog.FISH_TYPES.length);
  assert.equal(DECOR_KINDS.plant.types.length, 6);
  assert.equal(DECOR_KINDS.rock.types.length, 5);
  assert.equal(DECOR_KINDS.wood.types.length, 2);
  // 每种鱼都有明显不同的比例参数，不能只是同网格换色
  const shapes = new Set(catalog.FISH_TYPES.map((t) => `${t.body.depth.toFixed(2)}:${t.fins.tail}:${t.body.len}`));
  assert.equal(shapes.size, catalog.FISH_TYPES.length);
});

// ------------------------------------------------------------------ 造景增删改

test('新增造景受类型/总数上限约束，并落在缸内合法范围', () => {
  let state = validate(initial(1000), 1000);
  state.decor = [];
  for (let i = 0; i < DECOR_KINDS.rock.max; i += 1) {
    ({ state } = addDecor(state, 'rock', 'pebble', 100 + i, 1000));
  }
  assert.equal(state.decor.length, DECOR_KINDS.rock.max);
  assert.throws(() => addDecor(state, 'rock', 'pebble', 5, 1000), /上限/);
  // 其它类型仍可添加，总数不超过 DECOR_MAX
  let next = addDecor(state, 'plant', 'moss', 7, 1000).state;
  assert.equal(next.decor.length, DECOR_KINDS.rock.max + 1);
  assert.ok(next.decor.every((d) => d.x >= 0 && d.x <= 1 && d.z >= 0 && d.z <= 1 && d.scale >= 0.6 && d.scale <= 1.6));
});

test('拖动/旋转/缩放的边界会被夹住，删除与撤销（状态快照）可用', () => {
  let { state, object } = addDecor(validate(initial(1000), 1000), 'plant', 'vallis', 5, 1000);
  const id = object.id;
  validate(state, 1000);
  ({ state } = updateDecor(state, id, { x: -3, z: 4, rot: -1, scale: 99 }, 1000));
  const moved = state.decor.find((d) => d.id === id);
  assert.equal(moved.x, 0);
  assert.equal(moved.z, 1);
  assert.ok(moved.rot >= 0 && moved.rot < Math.PI * 2);
  assert.equal(moved.scale, 1.6);
  assert.deepEqual(clampTransform({ x: 0.5, z: 0.5, rot: 0, scale: 1 }), { x: 0.5, z: 0.5, rot: 0, scale: 1 });

  const beforeSeed = moved.seed;
  const reshuffled = reshuffleDecor(state, id, 777, 1000).state;
  assert.notEqual(reshuffled.decor.find((d) => d.id === id).seed, beforeSeed);
  assert.equal(reshuffled.decor.find((d) => d.id === id).x, moved.x, '换造型不改位置');

  const removed = removeDecor(reshuffled, id, 1000).state;
  assert.equal(removed.decor.some((d) => d.id === id), false);
});

test('canonicalState 只包含持久字段：savedAt / 瞬时位置不上传', () => {
  const state = validate(initial(1000), 1000);
  const a = canonicalState(state);
  state.savedAt = 999999;
  assert.equal(canonicalState(state), a, 'savedAt 不参与去抖比较');
  state.decor[0].x += 0.01;
  assert.notEqual(canonicalState(state), a, '造景位置变化必须触发上传');
});

// ------------------------------------------------------------------ 校验

test('导入会拒绝坏数据，限制数值范围并丢弃陌生字段', () => {
  assert.throws(() => validate({ version: 9, fish: [] }));
  assert.throws(() => validate({ version: 2, fish: [] }), /存档格式不正确/);
  const state = validate(initial(1000), 1000);
  state.fish[0].growth = 40;
  state.fish[0].meals = -3;
  state.injected = 'bad';
  const parsed = validate(state, 1000);
  assert.equal(parsed.fish[0].growth, 1);
  assert.equal(parsed.fish[0].meals, 0);
  assert.equal(parsed.injected, undefined);

  const dup = validate(initial(1000), 1000);
  dup.fish[1].id = dup.fish[0].id;
  assert.throws(() => validate(dup, 1000));

  const tooMany = validate(initial(1000), 1000);
  tooMany.decor = Array.from({ length: DECOR_MAX + 1 }, (_, i) => ({
    id: `x${i}`, kind: 'plant', type: 'moss', x: 0.5, z: 0.5, rot: 0, scale: 1, seed: i, v: 1
  }));
  assert.throws(() => validate(tooMany, 1000), /造景数量超出上限/);
});

test('未知但格式合法的鱼种 id 会被保留（未来新增鱼型不会被旧客户端改写）', () => {
  const state = validate(initial(1000), 1000);
  state.fish[0].species = 'future_fish';
  const parsed = validate(state, 1000);
  assert.equal(parsed.fish[0].species, 'future_fish');
});

test('存档往返：storage adapter 保存/读取同一份 v2 存档', () => {
  const map = new Map();
  const store = createStorage({ getItem: (k) => map.get(k), setItem: (k, v) => map.set(k, v) });
  const state = initial(1000);
  state.fish[0].name = '我的小鱼';
  store.save(state);
  const loaded = store.load();
  assert.equal(loaded.fish[0].name, '我的小鱼');
  assert.equal(loaded.version, STATE_VERSION);
  assert.equal(canonicalState(loaded), canonicalState(validate(state, 1000)));
});

test('随机数工具确定可复现', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i += 1) assert.equal(a(), b());
  assert.notEqual(hashSeed('a'), hashSeed('b'));
});

test('normalizing an in-range decor rotation preserves its exact cloud value across reads', () => {
  const original = initial();
  original.decor[0].rot = 0.1;
  let restored = original;
  for (let i = 0; i < 10; i++) restored = validate(restored);
  assert.equal(restored.decor[0].rot, 0.1);
});
