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
import { readFileSync } from 'node:fs';
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
/** 浏览器工具怎么交给 agent：自动（优先原生，失败回退）/ 只用原生 / 只用 MCP。 */
const TOOL_SURFACES = ['auto', 'native', 'mcp'];
/** 接管空闲自动交还的取值边界（与 electron/src/browser-control.ts 一致）。 */
const AUTO_RELEASE_MIN = 5;
const AUTO_RELEASE_MAX = 600;
const AUTO_RELEASE_DEFAULT = 30;
function clampAutoReleaseSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AUTO_RELEASE_DEFAULT;
  return Math.min(AUTO_RELEASE_MAX, Math.max(AUTO_RELEASE_MIN, Math.round(value)));
}

/** 控制权提示的来源标记：绝不能是 'user'（那会被当成真实用户提问）。 */
const CONTROL_NOTE_SOURCE = 'desktop-shell-browser-control';

/** 默认设置：字段与桌面壳 Rust 侧 `ShellSettings` 对齐（camelCase）。 */
const DEFAULT_SETTINGS = {
  version: '0.0.0',
  revision: 0,
  closeBehavior: 'minimizeToTray',
  proxy: { enabled: false, httpsProxy: '', httpProxy: '', noProxy: '' },
  service: { port: 41729 },
  updates: { checkDesktopOnStart: true, checkDshOnStart: true },
  browser: { enabled: true, agentTools: 'auto', autoReleaseSeconds: 30 },
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
    if (!['closeBehavior', 'proxy', 'service', 'updates', 'browser'].includes(key)) {
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

  if (patch.browser !== undefined) {
    const browser = patch.browser;
    if (browser === null || typeof browser !== 'object' || Array.isArray(browser)) {
      return { error: 'browser 必须是对象' };
    }
    if (browser.enabled === undefined && browser.agentTools === undefined) {
      next.browser = {};
    } else {
      const nextBrowser = {};
      if (browser.enabled !== undefined) {
        if (typeof browser.enabled !== 'boolean') return { error: 'browser.enabled 必须是布尔值' };
        nextBrowser.enabled = browser.enabled;
      }
      if (browser.agentTools !== undefined) {
        if (!TOOL_SURFACES.includes(browser.agentTools)) {
          return { error: `browser.agentTools 必须是 ${TOOL_SURFACES.join(' / ')} 之一` };
        }
        nextBrowser.agentTools = browser.agentTools;
      }
      if (browser.autoReleaseSeconds !== undefined) {
        if (typeof browser.autoReleaseSeconds !== 'number' || !Number.isFinite(browser.autoReleaseSeconds)) {
          return { error: 'browser.autoReleaseSeconds 必须是数字（秒）' };
        }
        nextBrowser.autoReleaseSeconds = browser.autoReleaseSeconds;
      }
      next.browser = nextBrowser;
    }
  }

  return { patch: next };
}

/** 补齐缺失字段并把旧版文件（无 revision/service/updates）升级为当前形状。 */
function withDefaults(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const proxy = source.proxy ?? {};
  const service = source.service ?? {};
  const updates = source.updates ?? {};
  const browser = source.browser ?? {};
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
    browser: {
      enabled: browser.enabled !== false,
      agentTools: TOOL_SURFACES.includes(browser.agentTools) ? browser.agentTools : 'auto',
      autoReleaseSeconds: clampAutoReleaseSeconds(browser.autoReleaseSeconds),
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

const TOOLS_FILENAME = 'browser-tools.json';

import { BROWSER_SKILL } from './browser-skill.js';

/** 把目录里的一条定义变成 DSH 原生工具（薄代理：执行仍在桌面壳里）。 */
function buildNativeTool(definition, endpoint, token, rememberSession) {
  return {
    name: definition.name,
    description: definition.description,
    // 目录里的 schema 已经落在原生注册表接受的子集内（见 browser-tool-schema.test.ts）。
    parameters: definition.inputSchema,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      // 记下**真正在驱动浏览器的会话**：控制权提示要写进这个会话，而不是面板碰巧报上来的那个
      // （两者在多会话/新建会话时可能不是同一个，实测踩过：提示因此落到了一个不活动的会话）。
      rememberSession?.(exec?.agent?.session);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        // 带上会话 id：桌面壳按会话隔离浏览器标签（第二个会话不能复用第一个的页面）。
        body: JSON.stringify({ name: definition.name, args: args ?? {}, sessionId: exec?.agent?.session?.id ?? '' }),
        signal: exec?.signal,
      });
      if (!response.ok) throw new Error(`浏览器工具桥返回 HTTP ${response.status}`);
      const payload = await response.json();
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .join('\n');
      // 抛错才会让这次调用在 DSH 侧显示为失败；返回文本则视为成功。
      if (payload.isError === true) throw new Error(text === '' ? '浏览器工具执行失败' : text);
      return text;
    },
  };
}

export function apply(ctx, config) {
  const bridgeDir = process.env.DSH_DESKTOP_BRIDGE_DIR ?? null;
  console.log(
    `[dsh-desktop-shell] host apply pid=${process.pid} bridgeDir=${bridgeDir ?? '(unset)'}`,
  );

  // ── 往会话里写「浏览器控制权」提示 ────────────────────────────────────────────
  //
  // 用 `user/message` + 自定义 `source.kind`：DSH 会把这种事件投影进模型看到的历史，
  // 但只有 `source.kind === 'user'` 才被当作真实用户提问（不会因此凭空起一个新回合）。
  // 这正是 DSH 自己的 dsh-agent-instructions 注入工作区指令用的办法。
  let sessionsService;
  /** 最近一次真正调用浏览器工具的会话 id（控制权提示的首选投递目标）。 */
  let driverSessionId;
  const rememberSession = (session) => {
    const id = session?.id ?? session?.sessionId;
    if (typeof id === 'string' && id !== '') driverSessionId = id;
  };
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionsService = sessionCtx.sessions;
    console.log('[dsh-desktop-shell] 已接入 sessions 服务（可写入控制权提示）');
  });

  /** @returns {{ok: boolean, error?: string, liveSessions?: string[]}} */
  const appendSessionNote = (sessionId, text) => {
    if (sessionsService === undefined) {
      console.log('[dsh-desktop-shell] 写入控制权提示失败：sessions 服务不可用');
      return { ok: false, error: 'sessions-service-unavailable' };
    }
    const live = () => {
      try {
        return (sessionsService.list?.() ?? []).map((entry) => entry?.id ?? String(entry)).slice(0, 8);
      } catch {
        return [];
      }
    };
    try {
      // 优先用「正在驱动浏览器的那个会话」（原生工具执行时记下的），面板报的 id 只作为回退：
      // DSH 的 sessions.get() 只解析**活动**会话，而面板所在的会话可能不是同一个/还没有回合。
      const candidates = [driverSessionId, sessionId].filter((value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index);
      let target;
      let used;
      for (const candidate of candidates) {
        const found = sessionsService.get(candidate);
        if (found !== undefined) { target = found; used = candidate; break; }
      }
      if (target === undefined) {
        console.log(`[dsh-desktop-shell] 写入控制权提示失败：候选会话都不可用（面板=${sessionId || '(无)'}，驱动=${driverSessionId || '(未记录)'}；活动：${live().join(', ') || '(无)'}）`);
        return { ok: false, error: 'unknown-session', liveSessions: live() };
      }
      target.append(
        'user/message',
        { role: 'user', content: [{ type: 'text', text }], source: { kind: CONTROL_NOTE_SOURCE } },
        { surfaceOp: 'append' },
      );
      console.log(`[dsh-desktop-shell] 已向会话 ${used}${used === sessionId ? '' : '（按浏览器驱动会话）'} 写入控制权提示：${text.slice(0, 40)}…`);
      return { ok: true };
    } catch (error) {
      console.log(`[dsh-desktop-shell] 写入控制权提示失败：${error?.message ?? String(error)}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  // ── 内置技能：随插件分发，用户无需安装任何东西 ────────────────────────────────
  ctx.inject(['skills'], (skillCtx) => {
    try {
      skillCtx.skills.register(BROWSER_SKILL);
      console.log(`[dsh-desktop-shell] 已注册内置技能 ${BROWSER_SKILL.name}`);
    } catch (error) {
      // 技能服务在旧/新版本里换了形状：记一条日志跳过，面板与工具不受影响。
      console.log(`[dsh-desktop-shell] 注册内置技能失败（忽略）：${error?.message ?? String(error)}`);
    }
  });

  // ── 原生浏览器工具：与 MCP 同一个目录来源，执行仍在桌面壳里 ──────────────────
  const nativeEndpoint = config?.nativeTools?.url;
  const nativeToken = config?.nativeTools?.token;
  if (typeof nativeEndpoint === 'string' && nativeEndpoint !== '' && typeof nativeToken === 'string') {
    ctx.inject(['tools'], (toolCtx) => {
      let report = { ok: false, count: 0, error: '' };
      try {
        if (bridgeDir === null) throw new Error('缺少 DSH_DESKTOP_BRIDGE_DIR');
        const catalog = JSON.parse(readFileSync(join(bridgeDir, TOOLS_FILENAME), 'utf8'));
        const definitions = Array.isArray(catalog?.tools) ? catalog.tools : [];
        if (definitions.length === 0) throw new Error('工具目录为空');
        for (const definition of definitions) {
          toolCtx.tools.register(buildNativeTool(definition, nativeEndpoint, nativeToken, rememberSession));
        }
        report = { ok: true, count: definitions.length };
        console.log(`[dsh-desktop-shell] 已注册 ${definitions.length} 个原生浏览器工具`);
      } catch (error) {
        report = { ok: false, count: 0, error: error?.message ?? String(error) };
        console.log(`[dsh-desktop-shell] 注册原生浏览器工具失败：${report.error}`);
      }
      // 回报给桌面壳：失败时下次启动会自动改用 MCP 工具，而不是让 agent 什么都看不到。
      const reportUrl = config?.nativeTools?.reportUrl;
      void fetch(typeof reportUrl === 'string' && reportUrl !== '' ? reportUrl : nativeEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${nativeToken}` },
        body: JSON.stringify(report),
      }).catch((error) => {
        console.log(`[dsh-desktop-shell] 回报注册结果失败（忽略）：${error?.message ?? String(error)}`);
      });
    });
  }

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
            // 哪个会话正在驱动浏览器（原生工具执行时记下的）。壳用它来让面板打开侧边栏浏览器：
            // 面板可能从未被打开过，也就从没上报过 sessionId。
            driverSessionId: driverSessionId ?? null,
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

        if (req.method === 'POST' && url.pathname === `${ROUTE}/session-note`) {
          if (!tokenValid(req)) {
            console.log('[dsh-desktop-shell] 拒绝 session-note：bootstrap token 无效或已过期');
            return sendJson(res, 403, { ok: false, error: 'invalid-token' });
          }
          const contentType = String(req.headers['content-type'] ?? '');
          if (!contentType.toLowerCase().startsWith('application/json')) {
            console.log(`[dsh-desktop-shell] 拒绝 session-note：content-type=${contentType || '(空)'}`);
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
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
          if (sessionId === '' || text === '') {
            return sendJson(res, 400, { ok: false, error: 'missing-session-or-text' });
          }
          const result = appendSessionNote(sessionId, text);
          return sendJson(res, result.ok ? 200 : 409, result);
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
            browser: patch.browser === undefined ? current.browser : { ...current.browser, ...patch.browser },
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