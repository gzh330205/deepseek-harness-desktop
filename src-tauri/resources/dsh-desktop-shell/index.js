/**
 * dsh-desktop-shell —— host 半。
 *
 * 由 DSH Desktop 启动时通过 `--patch` overlay 注入，随桌面安装包分发，
 * 不写入用户 profile，也不需要 pnpm 安装。
 *
 * 数据真相源是桌面壳的 `shell-settings.json`（位于 `DSH_DESKTOP_BRIDGE_DIR`）；
 * 本插件只做读写与校验，不维护第二份状态。
 *
 * 安全约定（P0 实测得出）：`webServer.register` 注册的路由**不受** DSH 浏览器
 * 会话认证保护，任何本机浏览器都能直接请求。因此除 `/ping` 外的所有端点都：
 *   1) 拒绝跨站（`Sec-Fetch-Site: cross-site`，或 Origin 的 host 与 Host 不一致）；
 *   2) 把请求携带的 Cookie 回探 `GET /`，只有 200 才视为已认证——即复用 DSH 自己
 *      的认证，使本插件 API 与 DSH 页面同等保护级别（正向结果缓存 5 秒）；
 *   3) 写操作还要求一次性 bootstrap token（`x-dsh-desktop-shell-token`），
 *      并且只接受 `application/json`。
 * 明确不在防御范围内：以同一用户身份运行的本地进程（它本来就能直接读设置文件）。
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'desktop-shell';

export const inject = [];

const ROUTE = '/dsh-desktop-shell/v1';
const FACTS_FILENAME = 'desktop-facts.json';
const SETTINGS_FILENAME = 'shell-settings.json';
const AUTH_PROBE_TIMEOUT_MS = 2000;
const AUTH_CACHE_TTL_MS = 5000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks5h'];
const CLOSE_BEHAVIORS = ['minimizeToTray', 'exit'];

/** 默认设置：字段与桌面壳 Rust 侧 `ShellSettings` 对齐（camelCase）。 */
const DEFAULT_SETTINGS = {
  version: '0.0.0',
  revision: 0,
  closeBehavior: 'minimizeToTray',
  proxy: { enabled: false, httpsProxy: '', httpProxy: '', noProxy: '' },
  service: { port: 41729 },
  updates: { checkDesktopOnStart: true, checkDshOnStart: true },
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** 跨站判定：浏览器可伪造，但足以挡住网页发起的 CSRF；本地进程不在防御范围。 */
function sameOrigin(req, host) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 复用 DSH 自身认证：带请求 Cookie 回探 `GET /`，200 视为已认证，401 视为未认证。 */
async function probeAuthentication(req, host) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string' || cookie === '') return false;
  try {
    const response = await fetch(`http://${host}/`, {
      headers: { cookie },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** 一次有界 JSON 读取；超过上限或不是 JSON 都算客户端错误。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}

/** 代理地址规范化：补全协议、校验协议白名单；空值原样保留。 */
function normalizeProxyUrl(raw, label) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return { value: '' };
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: `${label}不是有效的代理地址` };
  }
  if (!PROXY_SCHEMES.includes(parsed.protocol.replace(':', ''))) {
    return { error: `${label}只支持 http / https / socks5 / socks5h` };
  }
  if (parsed.hostname === '') return { error: `${label}缺少主机名` };
  return { value: candidate };
}

function normalizeNoProxy(raw) {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .join(',');
}

/**
 * 校验客户端提交的补丁。只接受已知字段，未知字段直接报错，
 * 避免拼错字段名时静默丢配置。
 * @returns {{patch?: object, error?: string}}
 */
function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: '设置必须是对象' };
  }
  const next = {};
  for (const key of Object.keys(patch)) {
    if (!['closeBehavior', 'proxy', 'service', 'updates'].includes(key)) {
      return { error: `未知设置项：${key}` };
    }
  }

  if (patch.closeBehavior !== undefined) {
    if (!CLOSE_BEHAVIORS.includes(patch.closeBehavior)) {
      return { error: 'closeBehavior 取值无效' };
    }
    next.closeBehavior = patch.closeBehavior;
  }

  if (patch.proxy !== undefined) {
    const proxy = patch.proxy;
    if (proxy === null || typeof proxy !== 'object' || Array.isArray(proxy)) {
      return { error: 'proxy 必须是对象' };
    }
    const enabled = proxy.enabled === undefined ? false : proxy.enabled;
    if (typeof enabled !== 'boolean') return { error: 'proxy.enabled 必须是布尔值' };
    const https = normalizeProxyUrl(proxy.httpsProxy ?? '', 'HTTPS 代理地址');
    if (https.error !== undefined) return { error: https.error };
    const http = normalizeProxyUrl(proxy.httpProxy ?? '', 'HTTP 代理地址');
    if (http.error !== undefined) return { error: http.error };
    if (enabled && https.value === '' && http.value === '') {
      return { error: '已启用代理，但至少需要填写一个代理地址' };
    }
    next.proxy = {
      enabled,
      httpsProxy: https.value,
      httpProxy: http.value,
      noProxy: normalizeNoProxy(proxy.noProxy),
    };
  }

  if (patch.service !== undefined) {
    const service = patch.service;
    if (service === null || typeof service !== 'object' || Array.isArray(service)) {
      return { error: 'service 必须是对象' };
    }
    const port = Number(service.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { error: '端口必须是 1024–65535 之间的整数' };
    }
    next.service = { port };
  }

  if (patch.updates !== undefined) {
    const updates = patch.updates;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      return { error: 'updates 必须是对象' };
    }
    const result = {};
    for (const key of ['checkDesktopOnStart', 'checkDshOnStart']) {
      if (updates[key] === undefined) continue;
      if (typeof updates[key] !== 'boolean') return { error: `updates.${key} 必须是布尔值` };
      result[key] = updates[key];
    }
    next.updates = result;
  }

  return { patch: next };
}

/** 补齐缺失字段并把旧版文件（无 revision/service/updates）升级为当前形状。 */
function withDefaults(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const proxy = source.proxy ?? {};
  const service = source.service ?? {};
  const updates = source.updates ?? {};
  const port = Number(service.port);
  return {
    ...source,
    version: typeof source.version === 'string' ? source.version : DEFAULT_SETTINGS.version,
    revision: Number.isInteger(source.revision) ? source.revision : 0,
    closeBehavior: CLOSE_BEHAVIORS.includes(source.closeBehavior)
      ? source.closeBehavior
      : DEFAULT_SETTINGS.closeBehavior,
    proxy: {
      enabled: proxy.enabled === true,
      httpsProxy: typeof proxy.httpsProxy === 'string' ? proxy.httpsProxy : '',
      httpProxy: typeof proxy.httpProxy === 'string' ? proxy.httpProxy : '',
      noProxy: typeof proxy.noProxy === 'string' ? proxy.noProxy : '',
    },
    service: {
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SETTINGS.service.port,
    },
    updates: {
      checkDesktopOnStart: updates.checkDesktopOnStart !== false,
      checkDshOnStart: updates.checkDshOnStart !== false,
    },
  };
}

async function readSettings(bridgeDir) {
  try {
    const raw = await readFile(join(bridgeDir, SETTINGS_FILENAME), 'utf8');
    return withDefaults(JSON.parse(raw));
  } catch {
    return withDefaults(null);
  }
}

/** 原子写：临时文件 + rename，避免 DSH/桌面壳同时读到半个文件。 */
async function writeSettings(bridgeDir, settings) {
  const target = join(bridgeDir, SETTINGS_FILENAME);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(temp, target);
}

/**
 * 聚合「现在停掉 DSH 会打断什么」（A1）。
 *
 * 不猜、不读内部字段：DSH 自己已经把这个问题做成了公开事件，
 * `workspace/session-activity` 由 `dsh-agent`（运行中的回合，含子代理与等待审批）、
 * `dsh-jobs`（运行中/停止中的后台任务）、`dsh-schedule`（已挂定时器）、
 * `dsh-subagent`、`dsh-workspace` 各自累加自己的 family；这里对每个**已加载**会话
 * 派发一次并收集结果。未加载的会话不计入（与官方口径一致）。
 *
 * 任何一步拿不到答案都返回 `unknown`，由桌面壳按「可能有任务」处理——
 * 绝不能把查不到当成没任务。
 *
 * @param ctx - 插件的 cordis 上下文。
 * @returns {{answer: 'idle'|'active'|'unknown', families: object[], sessions?: number, reason?: string}}
 */
async function collectSessionActivity(ctx) {
  const reflect = ctx.reflect;
  const sessions = typeof reflect?.get === 'function' ? reflect.get('sessions') : undefined;
  if (sessions === undefined || typeof sessions.list !== 'function') {
    return { answer: 'unknown', reason: 'sessions-service-unavailable', families: [] };
  }
  let live;
  try {
    live = sessions.list();
  } catch (error) {
    return { answer: 'unknown', reason: `sessions-list-failed: ${String(error)}`, families: [] };
  }
  const ids = (Array.isArray(live) ? live : [])
    .map((session) => (typeof session === 'string' ? session : session?.id))
    .filter((id) => typeof id === 'string' && id !== '');

  const families = [];
  for (const sessionId of ids) {
    let answer;
    try {
      // waterfall 的最后一个参数是终结回调，其返回值是累加基数：各监听方各自返回
      // `[自己的 family, ...next()]`，所以这里以空数组收尾。
      answer = await ctx.waterfall('workspace/session-activity', { sessionId }, () => []);
    } catch (error) {
      return { answer: 'unknown', reason: `session-activity-failed: ${String(error)}`, families: [] };
    }
    for (const family of Array.isArray(answer) ? answer : []) {
      const items = Array.isArray(family?.items) ? family.items : [];
      if (items.length === 0) continue;
      families.push({
        sessionId,
        kind: String(family?.kind ?? 'unknown'),
        count: items.length,
        labels: items.slice(0, 5).map((item) => String(item?.label ?? item?.id ?? '')),
      });
    }
  }
  return { answer: families.length > 0 ? 'active' : 'idle', families, sessions: ids.length };
}

/** 当前 DSH 进程实际生效的代理（桌面壳启动它时注入的环境变量）。 */function runningProxy() {
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? '';
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  return {
    enabled: httpsProxy !== '' || httpProxy !== '',
    httpsProxy,
    httpProxy,
    noProxy,
  };
}

function sameProxy(left, right) {
  return (
    left.enabled === right.enabled &&
    normalizeNoProxy(left.httpsProxy) === normalizeNoProxy(right.httpsProxy) &&
    normalizeNoProxy(left.httpProxy) === normalizeNoProxy(right.httpProxy) &&
    normalizeNoProxy(left.noProxy) === normalizeNoProxy(right.noProxy)
  );
}

export function apply(ctx) {
  const bridgeDir = process.env.DSH_DESKTOP_BRIDGE_DIR ?? null;
  console.log(
    `[dsh-desktop-shell] host apply pid=${process.pid} bridgeDir=${bridgeDir ?? '(unset)'}`,
  );

  /** 认证回探的短 TTL 缓存：同一会话内的连续请求不重复回探。 */
  const authCache = { cookie: null, expiresAt: 0 };
  /** 一次性 bootstrap token（进程内、10 分钟）。 */
  const tokens = new Map();

  const authenticated = async (req, host) => {
    const cookie = req.headers.cookie;
    if (typeof cookie !== 'string' || cookie === '') return false;
    const now = Date.now();
    if (authCache.cookie === cookie && authCache.expiresAt > now) return true;
    const ok = await probeAuthentication(req, host);
    if (ok) {
      authCache.cookie = cookie;
      authCache.expiresAt = now + AUTH_CACHE_TTL_MS;
    } else if (authCache.cookie === cookie) {
      authCache.cookie = null;
      authCache.expiresAt = 0;
    }
    return ok;
  };

  const mintToken = () => {
    const now = Date.now();
    for (const [token, expiresAt] of tokens) if (expiresAt <= now) tokens.delete(token);
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, now + TOKEN_TTL_MS);
    return token;
  };

  const tokenValid = (req) => {
    const token = req.headers['x-dsh-desktop-shell-token'];
    if (typeof token !== 'string') return false;
    const expiresAt = tokens.get(token);
    if (expiresAt === undefined || expiresAt <= Date.now()) return false;
    return true;
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const host = req.headers.host;
        const url = new URL(req.url ?? '/', `http://${host ?? 'localhost'}`);

        // 存活探针：不含任何桌面信息，允许匿名访问，便于启动诊断。
        if (req.method === 'GET' && url.pathname === `${ROUTE}/ping`) {
          return sendJson(res, 200, {
            ok: true,
            plugin: 'dsh-desktop-shell',
            pid: process.pid,
            bridge: bridgeDir !== null,
          });
        }

        if (host === undefined || !sameOrigin(req, host)) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin' });
        }
        if (!(await authenticated(req, host))) {
          return sendJson(res, 401, { ok: false, error: 'unauthenticated' });
        }

        // 结构化就绪：桌面壳用它确认「插件已装载」，不依赖 stdout 文本。
        // 放在 bridgeDir 判定之前：即使桥目录不可用，它也必须能回答。
        if (req.method === 'GET' && url.pathname === `${ROUTE}/ready`) {
          return sendJson(res, 200, {
            ok: true,
            plugin: 'dsh-desktop-shell',
            pid: process.pid,
            bridge: bridgeDir !== null,
          });
        }

        // 任务查询：把「现在退出/重启会打断什么」交给 DSH 自己回答。
        if (req.method === 'GET' && url.pathname === `${ROUTE}/tasks`) {
          const activity = await collectSessionActivity(ctx);
          return sendJson(res, 200, { ok: true, ...activity });
        }

        if (bridgeDir === null) {
          return sendJson(res, 503, { ok: false, error: 'bridge-unavailable' });
        }

        // 统一状态：事实 + 设置 + 待重启标记。
        if (req.method === 'GET' && url.pathname === `${ROUTE}/state`) {
          const settings = await readSettings(bridgeDir);
          let facts = null;
          try {
            facts = JSON.parse(await readFile(join(bridgeDir, FACTS_FILENAME), 'utf8'));
          } catch {
            facts = null;
          }
          return sendJson(res, 200, {
            ok: true,
            facts,
            settings,
            revision: settings.revision,
            pendingRestart: !sameProxy(settings.proxy, runningProxy()),
            runningProxy: runningProxy(),
          });
        }

        if (req.method === 'GET' && url.pathname === `${ROUTE}/bootstrap`) {
          return sendJson(res, 200, { ok: true, token: mintToken(), expiresInMs: TOKEN_TTL_MS });
        }

        if (req.method === 'GET' && url.pathname === `${ROUTE}/settings`) {
          const settings = await readSettings(bridgeDir);
          return sendJson(res, 200, { ok: true, settings, revision: settings.revision });
        }

        if (req.method === 'PUT' && url.pathname === `${ROUTE}/settings`) {
          if (!tokenValid(req)) {
            return sendJson(res, 403, { ok: false, error: 'invalid-token' });
          }
          const contentType = String(req.headers['content-type'] ?? '');
          if (!contentType.toLowerCase().startsWith('application/json')) {
            return sendJson(res, 415, { ok: false, error: 'json-required' });
          }
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const current = await readSettings(bridgeDir);
          const expected = Number(body.revision);
          if (!Number.isInteger(expected) || expected !== current.revision) {
            return sendJson(res, 409, {
              ok: false,
              error: 'revision-conflict',
              settings: current,
              revision: current.revision,
            });
          }
          const validated = validatePatch(body.patch);
          if (validated.error !== undefined) {
            return sendJson(res, 400, { ok: false, error: validated.error, settings: current });
          }
          const patch = validated.patch ?? {};
          const next = {
            ...current,
            ...patch,
            proxy: patch.proxy === undefined ? current.proxy : { ...current.proxy, ...patch.proxy },
            service: patch.service === undefined ? current.service : { ...current.service, ...patch.service },
            updates: patch.updates === undefined ? current.updates : { ...current.updates, ...patch.updates },
            revision: current.revision + 1,
          };
          try {
            await writeSettings(bridgeDir, next);
          } catch (error) {
            return sendJson(res, 500, {
              ok: false,
              error: 'settings-write-failed',
              detail: error instanceof Error ? error.message : String(error),
            });
          }
          return sendJson(res, 200, {
            ok: true,
            settings: next,
            revision: next.revision,
            pendingRestart: !sameProxy(next.proxy, runningProxy()),
          });
        }

        return sendJson(res, 404, { ok: false, error: 'not-found' });
      },
    });
    console.log(`[dsh-desktop-shell] 已注册路由 ${ROUTE}/*（除 ping 外均需 DSH 会话认证）`);
  });
}
