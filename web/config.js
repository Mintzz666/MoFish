// 云端配置占位文件。
//
// 仓库里的这份故意留空 → 应用以「游客 / 本机保存」模式运行，不会发起任何云请求。
// 部署时由 build.mjs 读取环境变量生成 dist/config.js（同名文件，值被替换），
// 因此这里永远不会出现、也不需要出现 service_role / secret key。
//
// 只允许放这两项公开信息：
//   supabaseUrl    —— 项目地址，例如 https://abcdefghijklmnop.supabase.co
//   supabaseAnonKey—— anon（或 sb_publishable_…）公开 key，受 RLS 保护
const cloudConfig = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};

export default cloudConfig;
