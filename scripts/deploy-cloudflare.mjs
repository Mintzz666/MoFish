// Deploy only this checkout's MoFish worker. Credentials stay in the process environment.
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readCloudConfig } from '../web/cloud/config.js';
import { checkPhaseBTarget, phaseBEnvironment } from './phase-b-cloud-checks.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--dry-run', '--phase=b'].includes(arg))) throw new Error('只支持 --dry-run 与 --phase=b；Worker 名固定。');
const dryRun = args.includes('--dry-run');
const phaseB = args.includes('--phase=b');
const workerName = phaseB ? 'mofish-phase-b' : 'mofish';
try { loadEnvFile(new URL(phaseB ? '../.env.phase-b' : '../.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const sourceEnv = phaseB ? phaseBEnvironment(process.env) : process.env;
const config = readCloudConfig({
  supabaseUrl: sourceEnv.MOFISH_SUPABASE_URL,
  supabaseAnonKey: sourceEnv.MOFISH_SUPABASE_ANON_KEY
});
const missing = [];
if (phaseB) {
  try { checkPhaseBTarget(config.url, sourceEnv.MOFISH_SMOKE_EXPECTED_PROJECT_REF); }
  catch (error) { missing.push(error.message); }
}
if (config.mode !== 'ready') missing.push(phaseB
  ? 'MOFISH_B_SUPABASE_URL / MOFISH_B_SUPABASE_ANON_KEY（有效公开配置）'
  : 'MOFISH_SUPABASE_URL / MOFISH_SUPABASE_ANON_KEY（有效公开配置）');
// Local B deployments may reuse Wrangler's existing OAuth login. Never copy its
// stored token into an environment file or require a second persistent API token.
if (!phaseB && !dryRun && !process.env.CLOUDFLARE_API_TOKEN?.trim()) missing.push('CLOUDFLARE_API_TOKEN');
if (!dryRun && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');
if (missing.length) {
  console.error(`尚不能部署：请在环境变量或本机 ${phaseB ? '.env.phase-b' : '.env'} 配置 ${missing.join('、')}。`);
  console.error('步骤见 docs/CLOUD-SETUP.md。不要把密码或管理密钥发到聊天或提交 Git。');
  process.exitCode = 2;
} else {
  function run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repo, stdio: 'inherit', shell: false,
        env: { ...process.env, MOFISH_SUPABASE_URL: config.url, MOFISH_SUPABASE_ANON_KEY: config.anonKey,
          WRANGLER_SEND_METRICS: 'false' }
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${signal ? `被 ${signal} 中断` : `退出码 ${code}`}`));
      });
    });
  }
  try {
    const sourceSha = phaseB ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() : null;
    if (phaseB && !dryRun && execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) {
      throw new Error('B 部署要求干净的已提交工作区，以便精确核验源码 SHA。');
    }
    await run(process.execPath, ['build.mjs']);
    if (phaseB) await writeFile(new URL('../dist/deployment.json', import.meta.url), JSON.stringify({
      phase: 'b', worker: workerName, sourceSha, projectRef: sourceEnv.MOFISH_SMOKE_EXPECTED_PROJECT_REF
    }, null, 2) + '\n');
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '--yes', 'wrangler@4.151.0', 'deploy', '--config', 'wrangler.toml', '--name', workerName,
      ...(phaseB ? ['--message', `MoFish Phase B source=${sourceSha}`] : []),
      ...(dryRun ? ['--dry-run'] : [])
    ]);
  } catch (error) {
    console.error(`部署未完成：${error.message}`);
    process.exitCode = 1;
  }
}
