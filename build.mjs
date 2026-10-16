// 构建：把 web/ 原样复制到 dist/，并在配置了环境变量时把云端公开凭据写进 dist/config.js。
//
// 安全边界（构建期最后一道闸）：
// - 只接受 Supabase 项目 URL 与 anon / sb_publishable_ 公开 key；
// - 检测到 service_role JWT 或 sb_secret_ 前缀时直接让构建失败，避免管理密钥被打进前端；
// - 校验逻辑与运行时共用 web/cloud/config.js，不做两套判断。

import { cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readCloudConfig, classifyKey } from './web/cloud/config.js';
import { build } from 'esbuild';
import { loadEnvFile } from 'node:process';

try { loadEnvFile(new URL('./.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const url = (process.env.MOFISH_SUPABASE_URL || '').trim();
const anonKey = (process.env.MOFISH_SUPABASE_ANON_KEY || '').trim();

function configModule(values) {
  return `// 由 build.mjs 在构建时生成，请勿手工修改。
// 这里只允许出现项目 URL 与公开 key；service_role / secret 等管理密钥永不进入前端。
const cloudConfig = ${JSON.stringify(values, null, 2)};

export default cloudConfig;
`;
}

// 先校验，再动 dist/：配置有问题时直接失败，不能把上一次可用的产物删掉。
let resolved = null;
if (url || anonKey) {
  const keyKind = classifyKey(anonKey);
  if (keyKind === 'secret') {
    console.error('✖ 构建中止：MOFISH_SUPABASE_ANON_KEY 看起来是 service_role / secret key。');
    console.error('  这类密钥拥有绕过 RLS 的权限，绝不能出现在网页里。请改用 anon 或 sb_publishable_ key。');
    process.exit(1);
  }

  const config = readCloudConfig({ supabaseUrl: url, supabaseAnonKey: anonKey });
  if (config.mode === 'blocked') {
    console.error('✖ 构建中止：云端配置未通过校验。');
    for (const problem of config.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  resolved = { config, keyKind };
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('web', 'dist', { recursive: true });
await build({
  entryPoints: ['web/cloud/auth.js'],
  outfile: 'dist/cloud/auth.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'none'
});

if (resolved) {
  await writeFile('dist/config.js', configModule({
    supabaseUrl: resolved.config.url,
    supabaseAnonKey: resolved.config.anonKey
  }));
  console.log(`Built static aquarium in dist/ · 云同步已启用（项目 ${resolved.config.projectRef || resolved.config.url}，key 类型 ${resolved.keyKind}）`);
  console.log('提示：公开 key 会出现在前端属预期行为，数据边界由数据库 RLS 保证。');
} else {
  console.log('Built static aquarium in dist/ · 未配置云同步（dist/config.js 为空，游客模式）');
  console.log('如需启用：设置 MOFISH_SUPABASE_URL 与 MOFISH_SUPABASE_ANON_KEY 后重新构建（见 docs/CLOUD-SETUP.md）。');
}
