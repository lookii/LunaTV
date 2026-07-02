#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function loadLocalEnvFile() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (quote === '"') {
      value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvFile();

const runtimeEnvKeys = [
  'USERNAME', 'PASSWORD', 'NEXT_PUBLIC_STORAGE_TYPE',
  'UPSTASH_URL', 'UPSTASH_TOKEN', 'TMDB_API_KEY',
  'NEXT_PUBLIC_SITE_NAME', 'ANNOUNCEMENT', 'ENABLE_REGISTER',
  'SITE_BASE', 'REDIS_URL', 'KVROCKS_URL',
  'NEXT_PUBLIC_SEARCH_MAX_PAGE',
  'NEXT_PUBLIC_DOUBAN_PROXY_TYPE', 'NEXT_PUBLIC_DOUBAN_PROXY',
  'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE', 'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY',
  'NEXT_PUBLIC_DISABLE_YELLOW_FILTER', 'NEXT_PUBLIC_FLUID_SEARCH',
  'NEXT_PUBLIC_BANGUMI_API_TYPE', 'NEXT_PUBLIC_BANGUMI_API_PROXY',
  'NEXT_PUBLIC_BANGUMI_IMAGE_PROXY_TYPE', 'NEXT_PUBLIC_BANGUMI_IMAGE_PROXY',
  'NEXT_PUBLIC_CORSAPI_URL', 'NEXT_PUBLIC_SUB_URL',
  'DISABLE_HERO_TRAILER', 'DISABLE_SSRF_PROTECTION',
  'TVBOX_SUBSCRIBE_TOKEN', 'TRUSTED_NETWORK_IPS',
];

// 跳过认证的路径：静态资源、登录/注册页、公开 API
const skipPaths = [
  '/_next', '/favicon.ico', '/robots.txt', '/manifest.json',
  '/icons/', '/logo.png', '/screenshot.png',
  '/login', '/register', '/oidc-register', '/warning',
  '/api/login', '/api/register', '/api/logout', '/api/cron',
  '/api/server-config', '/api/tvbox', '/api/tvbox-config',
  '/api/live/merged', '/api/parse', '/api/bing-wallpaper',
  '/api/proxy/', '/api/telegram/', '/api/auth/oidc/',
  '/api/watch-room/', '/api/cache/', '/api/client-log',
];

// 用于 layout 注入时过滤掉 API 路径（API 认证由 edge middleware 处理）
const pageSkipPaths = JSON.stringify(skipPaths.filter(p => !p.startsWith('/api/')));

let savedProxyContent = null;
let savedLayoutContent = null;

// 构建前：在 generateMetadata() 中注入 SSR 认证检查
// generateMetadata 中的 redirect() 在 RSC 协议层面处理
// 配合客户端 guard script（注入到 <head>），用户不会看到内容闪现
function injectGenerateMetadataAuthCheck() {
  const layoutPath = join(process.cwd(), 'src', 'app', 'layout.tsx');
  if (!existsSync(layoutPath)) return false;

  let content = readFileSync(layoutPath, 'utf8');
  const marker = '/* edgeone-metadata-auth-guard */';
  if (content.includes(marker)) return true;

  // 添加 imports
  const importMarker = "import { cookies } from 'next/headers';";
  if (!content.includes(importMarker)) return false;
  if (!content.includes("import { redirect } from 'next/navigation';")) {
    content = content.replace(
      importMarker,
      `${importMarker}\nimport { redirect } from 'next/navigation';`
    );
  }
  if (!content.includes("import { headers } from 'next/headers';")) {
    content = content.replace(
      importMarker,
      `${importMarker}\nimport { headers } from 'next/headers';`
    );
  }

  // 定位 generateMetadata 函数内的 await cookies()
  const genMetaMarker = 'export async function generateMetadata';
  const genMetaIdx = content.indexOf(genMetaMarker);
  if (genMetaIdx === -1) return false;

  const cookiesCall = 'await cookies();';
  const idx = content.indexOf(cookiesCall, genMetaIdx);
  if (idx === -1) return false;

  const authCheck = `
  ${marker}
  // EdgeOne SSR auth guard (in generateMetadata)
  const __gmH = await headers();
  let __gmPath = __gmH.get('x-pathname') || __gmH.get('x-invoke-path') || '';
  if (!__gmPath) {
    const __gmRef = __gmH.get('referer') || '';
    try { if (__gmRef) __gmPath = new URL(__gmRef).pathname; } catch {}
  }
  if (!__gmPath) __gmPath = '/';
  const __gmSkip = ${pageSkipPaths};
  if (!__gmSkip.some((p) => __gmPath.startsWith(p))) {
    const __gmCookies = await cookies();
    if (!__gmCookies.get('user_auth') && !__gmCookies.get('auth')) {
      const __gmSearch = __gmH.get('x-search') || '';
      redirect('/login?redirect=' + encodeURIComponent(__gmPath + __gmSearch));
    }
  }
`;

  const insertPos = idx + cookiesCall.length;
  content = content.slice(0, insertPos) + authCheck + content.slice(insertPos);

  // 同步写入（后面 injectLayoutAuthCheck 会再次读取并覆盖）
  writeFileSync(layoutPath, content);
  console.log('[edgeone-build] Injected SSR auth guard into generateMetadata()');
  return true;
}

// 构建前：将 proxy.ts 转换为 middleware.ts
// EdgeOne 不完整支持 Next.js 16 proxy.ts，需要临时转换
// 同时简化 matcher（EdgeOne 不支持负向前瞻正则）并注入跳过路径
function convertProxyToMiddlewareForBuild() {
  const proxyPath = join(process.cwd(), 'src', 'proxy.ts');
  const middlewarePath = join(process.cwd(), 'src', 'middleware.ts');
  const backupPath = join(process.cwd(), 'src', 'proxy.ts.edgeone-backup');

  if (!existsSync(proxyPath) || existsSync(middlewarePath)) return false;

  savedProxyContent = readFileSync(proxyPath, 'utf8');
  let content = savedProxyContent;

  content = content.replace(/export async function proxy\b/, 'export async function middleware');

  // 简化 matcher：EdgeOne 不支持 (?!...)，改用匹配所有路径
  // 注意：不能用 /:path+（不匹配根路径 /），必须用 /:path*
  content = content.replace(
    /export const config = \{[\s\S]*?matcher[\s\S]*?\};/,
    `export const config = { matcher: ['/', '/:path*'] };`
  );

  // 在 middleware 函数体开头注入跳过路径检查
  // 替代原 matcher 负向前瞻排除的路径，避免 /login 被无限重定向
  const skipPathsLiteral = JSON.stringify(skipPaths);
  const skipInjection = `
  /* edgeone-middleware-skip-paths */
  const __edgeOneSkipPaths = ${skipPathsLiteral};
  if (__edgeOneSkipPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }`;

  const destructureRegex = /(const\s*\{\s*pathname\s*\}\s*=\s*request\.nextUrl\s*;)/;
  if (destructureRegex.test(content)) {
    content = content.replace(destructureRegex, `$1${skipInjection}`);
  } else {
    // 兜底：直接在函数签名后插入
    const fallback = `
  /* edgeone-middleware-skip-paths */
  const __edgeOnePathname = request.nextUrl.pathname;
  const __edgeOneSkipPaths = ${skipPathsLiteral};
  if (__edgeOneSkipPaths.some((p) => __edgeOnePathname.startsWith(p))) {
    return NextResponse.next();
  }`;
    const fnRegex = /(export\s+async\s+function\s+middleware\s*\([^)]*\)\s*\{)/;
    content = content.replace(fnRegex, `$1${fallback}`);
  }

  renameSync(proxyPath, backupPath);
  writeFileSync(middlewarePath, content);
  console.log('[edgeone-build] Created temporary middleware.ts with skip-paths injection');
  return true;
}

// 构建前：在 layout.tsx 注入客户端认证 guard
// 这个 script 在 React 水合前同步执行，防止页面内容闪现
// SSR auth check 由 injectGenerateMetadataAuthCheck() 在 generateMetadata() 中处理
function injectLayoutAuthCheck() {
  const layoutPath = join(process.cwd(), 'src', 'app', 'layout.tsx');
  if (!existsSync(layoutPath)) {
    console.warn('[edgeone-build] layout.tsx not found, skip auth injection');
    return false;
  }

  const original = readFileSync(layoutPath, 'utf8');
  savedLayoutContent = original;

  const marker = '/* edgeone-layout-auth-guard */';
  if (original.includes(marker)) return true;

  let content = original;

  // 注入客户端 guard script 到 <head> 最前面
  // 在 React 水合前同步执行，用户看不到内容闪现
  // 逻辑：
  //   1. URL 有 redirect= 参数 → 跳过（防止循环）
  //   2. 有 user_auth cookie → 跳过（已认证）
  //   3. 路径在 skipPaths 中 → 跳过（公开页面）
  //   4. 否则 → redirect 到 /login
  const guardJs = `(function(){try{var u=window.location.pathname||'/';var s=window.location.search||'';if(s.indexOf('redirect=')!==-1)return;if(document.cookie.indexOf('user_auth=')!==-1)return;var sk=${pageSkipPaths};for(var j=0;j<sk.length;j++){if(u.startsWith(sk[j]))return;}window.location.replace('/login?redirect='+encodeURIComponent(u+s));}catch(e){}})()`;
  const guardScript = `<script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(guardJs)} }} />`;
  const headIdx = content.indexOf('<head>');
  if (headIdx !== -1) {
    const headInsertPos = headIdx + '<head>'.length;
    content = content.slice(0, headInsertPos) + guardScript + content.slice(headInsertPos);
  }

  writeFileSync(layoutPath, content);
  console.log('[edgeone-build] Injected client auth guard into layout.tsx <head>');
  return true;
}

function restoreProxyAfterBuild(wasConverted) {
  if (!wasConverted) return;

  const middlewarePath = join(process.cwd(), 'src', 'middleware.ts');
  const backupPath = join(process.cwd(), 'src', 'proxy.ts.edgeone-backup');

  if (savedProxyContent) {
    writeFileSync(join(process.cwd(), 'src', 'proxy.ts'), savedProxyContent);
    rmSync(middlewarePath, { force: true });
    rmSync(backupPath, { force: true });
    savedProxyContent = null;
    console.log('[edgeone-build] Restored proxy.ts');
    return;
  }

  rmSync(middlewarePath, { force: true });
  if (existsSync(backupPath)) {
    renameSync(backupPath, join(process.cwd(), 'src', 'proxy.ts'));
  }
  console.log('[edgeone-build] Restored proxy.ts from backup');
}

function restoreLayoutAfterBuild() {
  if (!savedLayoutContent) return;
  writeFileSync(join(process.cwd(), 'src', 'app', 'layout.tsx'), savedLayoutContent);
  savedLayoutContent = null;
  console.log('[edgeone-build] Restored layout.tsx');
}

// 构建前准备
const wasConverted = convertProxyToMiddlewareForBuild();
// 客户端 guard script（<head> 中）已足够处理认证 redirect
// 不在 generateMetadata 中注入 SSR auth check，避免 F12 禁用缓存时的额外刷新
injectLayoutAuthCheck();

// 确保异常退出时也能清理
process.on('exit', () => {
  restoreProxyAfterBuild(wasConverted);
  restoreLayoutAfterBuild();
});

// 执行构建
const isInsideEdgeOneBuilder = process.env.NEXT_PRIVATE_STANDALONE === 'true';
const command = isInsideEdgeOneBuilder
  ? 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 pnpm build'
  : 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 edgeone makers build';

const child = spawn(command, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, BUILD_TARGET: 'edgeone', EDGEONE_PAGES: '1' },
});

child.on('exit', (code, signal) => {
  if (!signal && code === 0) {
    for (const file of ['edgeone.json', 'package.json']) {
      copyFileSync(join(process.cwd(), file), join(process.cwd(), '.edgeone', file));
    }
    // 清理可能残留的 .env 文件
    for (const envPath of [
      join(process.cwd(), '.edgeone', '.env'),
      join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', '.env'),
    ]) {
      rmSync(envPath, { force: true });
    }
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
