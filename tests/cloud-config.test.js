import test from 'node:test';
import assert from 'node:assert/strict';
import { readCloudConfig, classifyKey, decodeJwtPayload, describeCloudConfig } from '../web/cloud/config.js';
import { makeAccessToken } from './fake-supabase/supabase-fake.mjs';

const ANON = makeAccessToken('anon-role', { role: 'anon' });
const SERVICE = makeAccessToken('service-role', { role: 'service_role' });

test('未配置时进入游客模式，属正常状态而不是错误', () => {
  const config = readCloudConfig(null);
  assert.equal(config.mode, 'off');
  assert.equal(config.anonKey, '');
  assert.equal(describeCloudConfig(config), '未连接云端');
});

test('合法的 https 地址 + anon key 判定为可用，并解析项目 ref', () => {
  const config = readCloudConfig({ supabaseUrl: 'https://abcdefghijklmnop.supabase.co', supabaseAnonKey: ANON });
  assert.equal(config.mode, 'ready');
  assert.equal(config.projectRef, 'abcdefghijklmnop');
  assert.equal(config.url, 'https://abcdefghijklmnop.supabase.co');
  assert.equal(describeCloudConfig(config), '云服务已配置');
});

test('新版 publishable key 也被接受', () => {
  const config = readCloudConfig({ supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'sb_publishable_abcdefghijklmnop' });
  assert.equal(config.mode, 'ready');
  assert.equal(config.keyKind, 'publishable');
});

test('service_role / secret key 一律拒绝启用并把 key 清空', () => {
  for (const key of [SERVICE, 'sb_secret_abcdefghijklmnop']) {
    const config = readCloudConfig({ supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: key });
    assert.equal(config.mode, 'blocked', `${key.slice(0, 12)}… 必须被拒绝`);
    assert.equal(config.anonKey, '', '被拒绝时不允许把密钥继续传给前端代码');
    assert.ok(config.problems.some(p => p.includes('service_role') || p.includes('secret')));
    assert.ok(!JSON.stringify(config.problems).includes(key.slice(0, 20)), '问题描述里不能复制密钥内容');
  }
});

test('无法识别的 key 格式按拒绝处理（宁可游客模式，也不冒用错密钥的风险）', () => {
  const config = readCloudConfig({ supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'not-a-real-key' });
  assert.equal(config.mode, 'blocked');
  assert.equal(classifyKey('not-a-real-key'), 'unknown');
  assert.equal(classifyKey(''), 'unknown');
  assert.equal(classifyKey(ANON), 'anon');
});

test('非 https 地址被拒绝，本机 http 仅供本地联调', () => {
  const insecure = readCloudConfig({ supabaseUrl: 'http://example.com', supabaseAnonKey: ANON });
  assert.equal(insecure.mode, 'blocked');

  const local = readCloudConfig({ supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: ANON });
  assert.equal(local.mode, 'ready', '本机 http 允许（fake-supabase / supabase start 联调用）');

  const localhost = readCloudConfig({ supabaseUrl: 'http://localhost:54321', supabaseAnonKey: ANON });
  assert.equal(localhost.mode, 'ready');
});

test('项目地址不是 URL 时拒绝', () => {
  const config = readCloudConfig({ supabaseUrl: 'demo.supabase.co', supabaseAnonKey: ANON });
  assert.equal(config.mode, 'blocked');
  assert.ok(config.problems.some(p => p.includes('URL')));
});

test('decodeJwtPayload 能读出 role 与非 ASCII 声明', () => {
  const token = makeAccessToken('user-1', { role: 'authenticated' });
  const payload = decodeJwtPayload(token);
  assert.equal(payload.role, 'authenticated');
  assert.equal(payload.sub, 'user-1');
  assert.equal(decodeJwtPayload('garbage'), null);
  assert.equal(decodeJwtPayload(null), null);
});
