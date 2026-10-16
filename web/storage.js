// 本地存储层：游客存档与「按账号 + 鱼缸」隔离的云缓存。
//
// 设计要点（对应 ROADMAP 阶段 A 的要求）：
// - 游客存档键仍是 `mofish.v1`，键名与结构都不变，老用户直接复用旧存档。
// - 已登录时的缓存/待同步/元数据一律带上 userId 与 aquariumId，避免退出或换号串档。
// - 本模块不做任何网络请求，也不读凭据；只负责键名与序列化。
import { KEY as GUEST_KEY, validate, cloneState } from './model.js';

export const NAMESPACE = 'mofish';

export const keys = {
  guest: () => GUEST_KEY,
  session: () => `${NAMESPACE}.auth.session`,
  authFlow: () => `${NAMESPACE}.auth.flow`,
  currentAquarium: (userId) => `${NAMESPACE}.current.${userId}`,
  accountState: (userId, aquariumId) => `${NAMESPACE}.state.${userId}.${aquariumId}`,
  pending: (userId, aquariumId) => `${NAMESPACE}.pending.${userId}.${aquariumId}`,
  meta: (userId, aquariumId) => `${NAMESPACE}.meta.${userId}.${aquariumId}`,
  backup: (userId, aquariumId, stamp) => `${NAMESPACE}.backup.${userId}.${aquariumId}.${stamp}`,
  prefixForUser: (userId) => `${NAMESPACE}.state.${userId}.`
};

/** 冲突时最多保留几份本机备份，防止本地存储无限增长。 */
export const MAX_BACKUPS_PER_AQUARIUM = 3;

function safeParse(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 读取一份存档：结构不合法时返回 null，绝不把坏数据交给渲染层。 */
function readState(get, key) {
  const parsed = safeParse(get(key));
  if (!parsed) return null;
  try { return validate(parsed); } catch { return null; }
}

/** 该账号派生出的全部本地键（state / pending / meta / backup / current）。 */
function userKeyMatcher(userId) {
  const escaped = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${NAMESPACE}\\.(state|pending|meta|backup)\\.${escaped}\\.|^${NAMESPACE}\\.current\\.${escaped}$`);
}

export function createLocalStore(storage) {
  const get = (k) => { try { return storage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { storage.setItem(k, v); return true; } catch { return false; } };
  const del = (k) => { try { storage.removeItem(k); return true; } catch { return false; } };

  return {
    storage,

    // ---- 游客（未登录）----
    readGuest: () => readState(get, keys.guest()),
    writeGuest(state) { state.savedAt = Date.now(); return set(keys.guest(), JSON.stringify(state)); },
    hasGuest: () => get(keys.guest()) !== null,

    // ---- 会话（只存 Supabase 返回的会话，不存密码）----
    readSession: () => safeParse(get(keys.session())),
    writeSession: (session) => set(keys.session(), JSON.stringify(session)),
    clearSession: () => del(keys.session()),

    // ---- 等待处理的验证/重置链接 ----
    readAuthFlow: () => safeParse(get(keys.authFlow())),
    writeAuthFlow: (flow) => set(keys.authFlow(), JSON.stringify(flow)),
    clearAuthFlow: () => del(keys.authFlow()),

    // ---- 账号 + 鱼缸级缓存 ----
    // 指针：记录该账号当前使用的鱼缸 id 与已知 revision。离线时靠它找到本地缓存。
    readCurrent: (userId) => safeParse(get(keys.currentAquarium(userId))),
    writeCurrent: (userId, info) => set(keys.currentAquarium(userId), JSON.stringify(info)),
    clearCurrent: (userId) => del(keys.currentAquarium(userId)),

    readAccountState: (userId, aquariumId) => readState(get, keys.accountState(userId, aquariumId)),
    writeAccountState(userId, aquariumId, state) {
      return set(keys.accountState(userId, aquariumId), JSON.stringify(cloneState(state)));
    },
    dropAccountState: (userId, aquariumId) => del(keys.accountState(userId, aquariumId)),

    readPending: (userId, aquariumId) => readState(get, keys.pending(userId, aquariumId)),
    writePending(userId, aquariumId, state) {
      return set(keys.pending(userId, aquariumId), JSON.stringify(cloneState(state)));
    },
    clearPending: (userId, aquariumId) => del(keys.pending(userId, aquariumId)),

    readMeta: (userId, aquariumId) => safeParse(get(keys.meta(userId, aquariumId))),
    writeMeta: (userId, aquariumId, meta) => set(keys.meta(userId, aquariumId), JSON.stringify(meta)),
    clearMeta: (userId, aquariumId) => del(keys.meta(userId, aquariumId)),

    /**
     * 把一份未同步的本地存档归档为备份。
     * 用在「冲突时用户选择保留云端」这条路：本机改动不能被无声丢掉，用户之后仍可导出。
     * 同一鱼缸只保留最近 MAX_BACKUPS_PER_AQUARIUM 份。
     */
    writeBackup(userId, aquariumId, state, stamp = Date.now()) {
      const key = keys.backup(userId, aquariumId, stamp);
      const ok = set(key, JSON.stringify(cloneState(state)));
      const mine = this.listBackups(userId, aquariumId);
      for (const entry of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS_PER_AQUARIUM))) {
        del(entry.key);
      }
      return ok ? key : null;
    },

    /** 列出某鱼缸的备份（新的在后）。 */
    listBackups(userId, aquariumId) {
      const marker = `${NAMESPACE}.backup.${userId}.${aquariumId}.`;
      const out = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (typeof k === 'string' && k.startsWith(marker)) {
            out.push({ key: k, stamp: k.slice(marker.length), state: readState(get, k) });
          }
        }
      } catch { /* 忽略枚举失败 */ }
      return out.sort((a, b) => String(a.stamp).localeCompare(String(b.stamp)));
    },

    /** 该账号在本机留下的全部键（用于「退出并清除本机数据」这类显式动作）。 */
    listKeysForUser(userId) {
      const matcher = userKeyMatcher(userId);
      const out = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (typeof k === 'string' && matcher.test(k)) out.push(k);
        }
      } catch { /* 某些浏览器在隐私模式下不允许枚举 */ }
      return out.sort();
    },

    /** 只清除某个账号派生键（不碰游客存档、不碰其它账号）。 */
    forgetUser(userId) {
      const removable = this.listKeysForUser(userId);
      removable.forEach(del);
      return removable.length;
    }
  };
}
