#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const args=process.argv.slice(2),dry=args.includes('--dry-run');
function option(name){const i=args.indexOf(name);if(i<0)return null;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`${name} 缺少参数`);return args[i+1];}
function git(...args){return execFileSync('git',args,{encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']}).trim();}
function run(...args){execFileSync(args[0],args.slice(1),{stdio:'inherit'});}
try{
 const allowed=new Set(['--dry-run','--version','--message']);
 for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw Error(`未知参数：${args[i]}`);if(args[i]!=='--dry-run')i++;}
 if(git('status','--porcelain'))throw Error('请先审查并提交工作区改动，再发布；hook 不会自动提交未审查文件。');
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 const remote=git('ls-remote','origin','refs/heads/main','refs/tags/v*');
 const remoteRefs=new Map(remote.split('\n').filter(Boolean).map(line=>{const [sha,ref]=line.split(/\s+/);return [ref,sha];}));
 let version=option('--version')||pkg.version;
 const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
 if(!semver.test(version))throw Error('版本号须为 major.minor.patch，例如 0.2.0');
 if(!option('--version')){
  while(remoteRefs.has(`refs/tags/v${version}`)){
   const oldTag=`v${version}`;
   let taggedHead='';try{taggedHead=git('rev-parse',`${oldTag}^{commit}`);}catch{}
   if(taggedHead===git('rev-parse','HEAD'))throw Error(`${oldTag} 已发布，当前没有新提交。`);
   const [a,b,c]=version.split('.').map(Number);version=`${a}.${b}.${c+1}`;
  }
 }
 const tag=`v${version}`,head=git('rev-parse','HEAD');
 if(remoteRefs.has(`refs/tags/${tag}`))throw Error(`${tag} 已存在于 GitHub，请选择新版本号。`);
 let localTag='';try{localTag=git('rev-parse',`${tag}^{commit}`);}catch{}
 if(localTag&&localTag!==head)throw Error(`本地 ${tag} 已指向其他提交，请检查后再发布。`);
 // Fetch only the branch used for publication; never merge or overwrite remote history.
 git('fetch','origin','main');
 const base=git('rev-parse','FETCH_HEAD');
 if(git('merge-base',base,head)!==base)throw Error('GitHub main 有尚未整合的提交；请先处理分支差异。');
 console.log(`发布检查：${tag} → origin/main${dry?'（预演，不创建提交、标签或推送）':''}`);
 run('npm','test');run('npm','run','build');
 if(dry){console.log('预演通过。只有用户确认版本后才能执行正式发布。');process.exit(0);}
 if(pkg.version!==version){
  if(localTag)throw Error('待重试的标签与 package.json 版本不一致，请先检查。');
  pkg.version=version;writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
  git('add','package.json');git('commit','-m',`chore: release ${tag}`);
 }
 const message=option('--message')||`MoFish ${tag}`;
 if(!localTag)git('tag','-a',tag,'-m',message);
 // Branch + tag succeed together. No force pushes; failed pushes retain the local tag for retry.
 git('push','--atomic','origin','HEAD:refs/heads/main',`refs/tags/${tag}`);
 const verified=git('ls-remote','origin','refs/heads/main',`refs/tags/${tag}^{}`);
 if(!verified.includes(git('rev-parse','HEAD')))throw Error('推送后未能确认远端提交，请检查远端后再报告成功。');
 console.log(`已发布 ${tag}\n${verified}`);
}catch(error){
 console.error('发布停止：'+error.message);
 console.error('若网络推送失败，本地提交和标签会保留；恢复连接后用同一命令重试，不会强制覆盖远端。');
 process.exitCode=1;
}
