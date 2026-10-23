// Deploy only this checkout's MoFish worker. Credentials stay in the process environment.
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readCloudConfig } from '../web/cloud/config.js';
import {checkPhaseCTarget,phaseCEnvironment} from './phase-c-config.mjs';
import { checkPhaseBTarget, phaseBEnvironment } from './phase-b-cloud-checks.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--dry-run', '--phase=b', '--phase=c'].includes(arg))) throw new Error('只支持 --dry-run 与 --phase=b/--phase=c；Worker 名固定。');
const dryRun = args.includes('--dry-run');
const phaseB = args.includes('--phase=b');
const phaseC = args.includes('--phase=c');
if (phaseB && phaseC) throw new Error('只可选择一个部署阶段');
const qa = phaseB || phaseC;
const phaseName = phaseC ? 'c' : 'b';
const workerName = phaseC ? 'mofish-phase-c' : phaseB ? 'mofish-phase-b' : 'mofish';
try { loadEnvFile(new URL(phaseC ? '../.env.phase-c' : phaseB ? '../.env.phase-b' : '../.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const sourceEnv = phaseC ? phaseCEnvironment(process.env) : phaseB ? phaseBEnvironment(process.env) : process.env;
const config = readCloudConfig({
  supabaseUrl: sourceEnv.MOFISH_SUPABASE_URL,
  supabaseAnonKey: sourceEnv.MOFISH_SUPABASE_ANON_KEY
});
const missing = [];
if (qa) {
  try { (phaseC ? checkPhaseCTarget : checkPhaseBTarget)(config.url, sourceEnv.MOFISH_SMOKE_EXPECTED_PROJECT_REF); }
  catch (error) { missing.push(error.message); }
}
if (config.mode !== 'ready') missing.push(phaseC ? 'MOFISH_C_SUPABASE_URL / MOFISH_C_SUPABASE_ANON_KEY（有效公开配置）' : phaseB
  ? 'MOFISH_B_SUPABASE_URL / MOFISH_B_SUPABASE_ANON_KEY（有效公开配置）'
  : 'MOFISH_SUPABASE_URL / MOFISH_SUPABASE_ANON_KEY（有效公开配置）');
// Local B deployments may reuse Wrangler's existing OAuth login. Never copy its
// stored token into an environment file or require a second persistent API token.
if (!qa && !dryRun && !process.env.CLOUDFLARE_API_TOKEN?.trim()) missing.push('CLOUDFLARE_API_TOKEN');
if (!dryRun && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');
if (missing.length) {
  console.error(`尚不能部署：请在环境变量或本机 ${phaseC ? '.env.phase-c' : phaseB ? '.env.phase-b' : '.env'} 配置 ${missing.join('、')}。`);
  console.error('步骤见 docs/CLOUD-SETUP.md。不要把密码或管理密钥发到聊天或提交 Git。');
  process.exitCode = 2;
} else {
  function run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repo, stdio: 'inherit', shell: false,
        env: { ...process.env, MOFISH_SUPABASE_URL: config.url, MOFISH_SUPABASE_ANON_KEY: config.anonKey,
          WRANGLER_SEND_METRICS: 'false', ...(phaseC ? {MOFISH_PHASE:'c'} : {}) }
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${signal ? `被 ${signal} 中断` : `退出码 ${code}`}`));
      });
    });
  }
  try {
    const sourceSha = qa ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() : null;
    if (qa && !dryRun && execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) {
      throw new Error('QA 部署要求干净的已提交工作区，以便精确核验源码 SHA。');
    }
    await run(process.execPath, ['build.mjs']);
    const manifest = JSON.parse(await readFile(new URL('../dist/asset-manifest.json', import.meta.url), 'utf8'));
    if (qa) await writeFile(new URL('../dist/deployment.json', import.meta.url), JSON.stringify({
      phase: phaseName, worker: workerName, sourceSha, version: manifest.version, buildId: manifest.buildId,
      projectRef: sourceEnv.MOFISH_SMOKE_EXPECTED_PROJECT_REF
    }, null, 2) + '\n');
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '--yes', 'wrangler@4.151.0', 'deploy', '--config', 'wrangler.toml', '--name', workerName,
      ...(qa ? ['--message', `MoFish Phase ${phaseName.toUpperCase()} source=${sourceSha}`] : []),
      ...(dryRun ? ['--dry-run'] : [])
    ]);
  } catch (error) {
    console.error(`部署未完成：${error.message}`);
    process.exitCode = 1;
  }
}
