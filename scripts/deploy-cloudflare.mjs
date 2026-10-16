// Deploy only this checkout's MoFish worker. Credentials stay in the process environment.
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCloudConfig } from '../web/cloud/config.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--dry-run')) throw new Error('只支持 --dry-run 参数；部署目标固定为 MoFish。');
const dryRun = args.includes('--dry-run');
try { loadEnvFile(new URL('../.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const config = readCloudConfig({
  supabaseUrl: process.env.MOFISH_SUPABASE_URL,
  supabaseAnonKey: process.env.MOFISH_SUPABASE_ANON_KEY
});
const missing = [];
if (config.mode !== 'ready') missing.push('MOFISH_SUPABASE_URL / MOFISH_SUPABASE_ANON_KEY（有效公开配置）');
if (!dryRun && !process.env.CLOUDFLARE_API_TOKEN?.trim()) missing.push('CLOUDFLARE_API_TOKEN');
if (!dryRun && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');
if (missing.length) {
  console.error(`尚不能部署：请在环境变量或本机 .env 配置 ${missing.join('、')}。`);
  console.error('步骤见 docs/CLOUD-SETUP.md。不要把密码或管理密钥发到聊天或提交 Git。');
  process.exitCode = 2;
} else {
  function run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repo, stdio: 'inherit', shell: false,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${signal ? `被 ${signal} 中断` : `退出码 ${code}`}`));
      });
    });
  }
  try {
    await run(process.execPath, ['build.mjs']);
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '--yes', 'wrangler@4.151.0', 'deploy', '--config', 'wrangler.toml', '--name', 'mofish',
      ...(dryRun ? ['--dry-run'] : [])
    ]);
  } catch (error) {
    console.error(`部署未完成：${error.message}`);
    process.exitCode = 1;
  }
}
