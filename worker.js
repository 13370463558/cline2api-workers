/**
 * cline2api - Cloudflare Workers 版
 *
 * 逆向自 https://github.com/luawei1/cline2api (Go 版反向代理)
 *
 * 核心逻辑：
 *  1. 每次请求用 refreshToken 换 accessToken（缓存到内存，过期自动刷新）
 *  2. 把 OpenAI / Anthropic 请求转发到 https://api.cline.bot/api/v1/chat/completions
 *  3. SSE 流式响应剥掉上游 {data:{...}} 包装，透传给客户端
 *
 * 环境变量：
 *  - CLINE_REFRESH_TOKEN (必需)  Cline 账号的 refreshToken
 *  - API_KEY                (可选) 自定义访问 key；不设置则每次部署随机生成并打印到日志
 *
 * 用法（OpenAI 兼容）：
 *   curl https://你的worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
 */

import { connect } from "cloudflare:sockets";

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// 账号池：支持多个 Cline 账号，每个账号独立缓存 accessToken
// CLINE_REFRESH_TOKEN 环境变量可包含多行，每行一个 refreshToken，
// 额度用尽(空响应)时自动轮换下一个账号。
// 结构：{ refreshToken, accessToken, expiry, cooldownUntil }
let runtimeEnv = {};      // 当前请求的 env（供 SOCKS5 出站等工具函数读取）
let accounts = [];
let accountIndex = 0;          // round-robin 游标
let currentAccount = null;     // 当前正在使用的账号（串行队列下安全）

// 模型列表：原样使用 Cline /v1/models 返回的完整模型 ID。
// 不人为添加 cline/ 前缀；Telegram 会完整显示这些 ID，避免不同供应商模型名被截断后混淆。
const MODELS = [
  { id: "cline-free/deepseek-v4.1-flash", upstream: "cline-free/deepseek-v4.1-flash", provider: "cline", cost: "free" },
  { id: "deepseek/deepseek-v4-flash", upstream: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", upstream: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-pass/glm-5.2", upstream: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", upstream: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", upstream: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
  { id: "zai/glm-5.3-flash", upstream: "zai/glm-5.3-flash", provider: "zai", cost: "free" },
];

// ============ 动态模型列表 (2026-08-29) ============
// 优先从 Cline 官方 /v1/models 拉取, 失败回退到上面内置列表。
// 每 10 分钟刷新一次缓存。
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_TTL = 10 * 60 * 1000; // 10 分钟

async function refreshModels() {
  try {
    const now = Date.now();
    if (modelsCache && now - modelsCacheTime < MODELS_TTL) {
      return modelsCache;
    }
    const resp = await upstreamFetch(CLINE_API_BASE + "/models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) {
      console.log("[models] 官方拉取失败 HTTP", resp.status, "回退内置列表");
      return MODELS;
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      return MODELS;
    }
    // 只保留免费模型: :free 后缀 + Cline 官方免费白名单 (2026-08-29)
    const FREE_WHITELIST = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.2:free",
      "xiaomi/mimo-v2.5",
      "minimax/minimax-m3",
      "poolside/laguna-s-2.1",
      "cline-free/deepseek-v4.1-flash",
      "cline-free/muse-spark-1.3-contributor",
      "cline-free/solar-pro4",
    ];
    const baseList = data.data
      .filter((m) => {
        const id = m.id || "";
        if (":batch" in m && m.batch) return false;
        if (id.endsWith(":batch")) return false;
        if (id.includes(":free")) return true;
        if (FREE_WHITELIST.includes(id)) return true;
        return false;
      })
      .map((m) => {
        const id = m.id || "";
        const prefix = id.split("/")[0] || "cline";
        return { id, upstream: id, provider: prefix, cost: "free" };
      });
    // 合并 recommended-models 里的 cline-free 免费模型
    const freeExtra = await refreshFreeModels();
    for (const fm of freeExtra) {
      if (!baseList.some((b) => b.id === fm.id)) baseList.push(fm);
    }
    modelsCache = baseList;
    modelsCacheTime = now;
    console.log("[models] 动态拉取成功:", modelsCache.length, "个模型 (含 cline-free 免费通道)");
    return modelsCache;
  } catch (e) {
    console.log("[models] 拉取异常:", String(e).slice(0, 100), "回退内置列表");
    return MODELS;
  }
}


// =====================================================================
// Cline 官方免费模型列表（逆向自插件 recommended-models 接口）
// 官方插件用 https://api.cline.bot/api/v1/ai/cline/recommended-models 获取
// 免费 (cline-free/) 模型。这些模型走官方免费额度，不需要 credits。
// 反之 deepseek/deepseek-v4.1-flash 是付费档，余额不足返回 402 insufficient_credits。
// 动态刷新时同时拉这个接口，把 free 列表合并进模型池。
// =====================================================================
async function refreshFreeModels() {
  try {
    const resp = await upstreamFetch(CLINE_API_BASE + "/ai/cline/recommended-models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const list = Array.isArray(data?.free) ? data.free : [];
    return list
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, upstream: m.id, provider: m.id.split("/")[0] || "cline", cost: "free" }));
  } catch (e) {
    return [];
  }
}

// 默认模型：Cline 免费 DeepSeek V4.1 Flash 通道（cline-free/ 官方免费额度，无需 credits）
// 逆向自官方插件 recommended-models free 列表：cline-free/deepseek-v4.1-flash
const DEFAULT_MODEL = "cline-free/deepseek-v4.1-flash";
const VERSION = "1.2.0";

export default {
  async fetch(request, env) {
    runtimeEnv = env || {};
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // 健康诊断端点（无需鉴权，用于排查环境变量是否生效）
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const poolN = parseAccounts(env).length;
      const egress = upstreamEgressConfig(env);
      return jsonResponse({
        ok: true,
        version: VERSION,
        authenticated: !!(env.API_KEY),
        accounts: poolN,
        model: DEFAULT_MODEL,
        // 出站方式：socks5=已启用代理池；direct=原生 fetch 直连
        egress: egress.enabled ? "socks5" : "direct",
        socks5_proxies: egress.proxies.length,
        socks5_fallback: egress.enabled ? egress.fallback : null,
      }, 200);
    }

    // 全局鉴权：所有端点都需要 API Key（除 OPTIONS 预检）
    // 若未配置 API_KEY，则使用内置默认 key "cline2api-default-key"
    // (可选) 设 API_KEY="" 表示完全关闭鉴权
    // GET /v1/models — 免鉴权（GUI 验证需拉模型列表）
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return handleModels();
    }

    // POST 聊天端点
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        return handleChat(request, env);
      }
      if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
        return handleAnthropic(request, env);
      }
    }

    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------
// Token 管理
// ---------------------------------------------------------------------------

// 从环境变量解析账号池：CLINE_REFRESH_TOKEN 每行一个
function parseAccounts(env) {
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);
  if (tokens.length === 0) return [];

  // 若 token 列表变化（增删账号），重建账号池
  const changed =
    accounts.length !== tokens.length ||
    accounts.some((a, i) => a.refreshToken !== tokens[i]);
  if (changed) {
    accounts = tokens.map((rt) => ({
      refreshToken: rt,
      accessToken: null,
      expiry: 0,
      cooldownUntil: 0,
    }));
  }
  return accounts;
}

// 取得当前账号的 accessToken（独立缓存，失效/冷却则刷新）
async function getAccountToken(account) {
  const now = Date.now();
  // 冷却期内不可用
  if (account.cooldownUntil > now) {
    throw new Error("account_cooldown");
  }
  if (account.accessToken && now < account.expiry) {
    return account.accessToken;
  }
  const resp = await upstreamFetch(
    CLINE_API_BASE + "/auth/refresh",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: account.refreshToken,
        grantType: "refresh_token",
      }),
    },
    { env: runtimeEnv, accountIndex: accounts.indexOf(account) },
  );
  if (!resp.ok) {
    // 刷新失败：冷却 60s，交给上层切号
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_failed");
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_no_token");
  }
  account.accessToken = accessToken;
  // Cline 会在刷新时轮换 refreshToken；必须保存新 token，避免下一次刷新 invalid_grant。
  if (typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim()) {
    account.refreshToken = data.data.refreshToken.trim();
  }
  // 过期时间：优先服务端，兜底 10 分钟，留 60s 余量
  const expiresAt = data?.data?.expiresAt;
  let expiry = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60000;
  return accessToken;
}

// 轮询选择一个可用账号，返回该账号对象（并设置 currentAccount）
function pickAccount(pool) {
  for (let k = 0; k < pool.length; k++) {
    const acc = pool[accountIndex % pool.length];
    accountIndex = (accountIndex + 1) % pool.length;
    if (!acc.cooldownUntil || acc.cooldownUntil <= Date.now()) {
      currentAccount = acc;
      return acc;
    }
  }
  return null; // 全部冷却中
}

async function getAccessToken(env) {
  const pool = parseAccounts(env);
  if (pool.length === 0) {
    throw new Error("缺少 CLINE_REFRESH_TOKEN 环境变量");
  }
  // 最多尝试 pool.length 个账号（跳过冷却/刷新失败的）
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const acc = pool[attempt % pool.length]; // 逐个尝试
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue;
    currentAccount = acc;
    try {
      return await getAccountToken(acc);
    } catch (e) {
      if (e.message === "account_cooldown") continue;
      continue; // 刷新失败也切下个号
    }
  }
  // 全部失败，清冷却重试一次最早的
  const acc = pool[0];
  currentAccount = acc;
  acc.cooldownUntil = 0;
  try {
    return await getAccountToken(acc);
  } catch (e) {
    throw new Error("所有账号刷新 token 均失败");
  }
}

// Cline 客户端指纹请求头（官方靠这些头识别"是不是 Cline 客户端"）
// 缺少会被 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
function clineHeaders(sessionId) {
  return {
    Authorization: "Bearer workos:" + currentToken,
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

// 当前账号的 accessToken（供 clineHeaders 使用）
let currentToken = "";

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const acc = currentAccount || null;
  const token = await getAccessToken(env);
  currentToken = token;
  const headers = clineHeaders(sessionId);
  headers.Authorization = "Bearer workos:" + token;
  const resp = await upstreamFetch(
    CLINE_API_BASE + path,
    {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
    },
    { env: runtimeEnv, accountIndex: currentAccount ? accounts.indexOf(currentAccount) : -1 },
  );
  if (resp.status === 401 && !retried) {
    // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
    if (currentAccount) {
      currentAccount.cooldownUntil = Date.now() + 60 * 1000;
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 并发限流队列：上游免费通道并发超过 1 就返回空响应，这里强制串行 + 间隔
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // 全局串行队列尾巴
const MIN_GAP_MS = 800;            // 两次上游请求最小间隔

function enqueue(fn) {
  // 前一个任务结束后，等待间隔，再执行 fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // 不管成功失败都继续链，避免队列断裂
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析上游 429/限流响应里的等待时间，返回毫秒
// 支持格式: "Try again in 2h 51m" / "Try again in 30m" / "Try again in 1h" / "Try again in 15s"
function parseCooldown(body, status) {
  const m = (body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000); // 上限 6 小时
  }
  // 429 默认 5 分钟；空响应默认 60 秒
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

// 带重试的 clineFetch：429限流/空响应/5xx 自动切换账号 + 指数退避重试
// 一个号额度用完或限流(429 Daily free limit reached)时：
//   - 冷却该账号（冷却时长按上游提示，如 2h51m）
//   - 自动轮换到下一个号重试同一请求
// 所有账号都冷却时，直接返回原始响应（不空转）
async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    lastResp = resp;

    // 统一读 body（clone 不消耗流）
    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (e) {}

    // 判定"额度/限流"信号（需要切号）：
    // 1. 429（Daily free limit reached / rate limit）
    // 2. 5xx 且含 empty response content
    // 3. 200 非流式但 body 是空响应包装
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content")) ||
      (resp.ok && !isStream && bodyText.includes("empty response content"));

    if (isLimitHit) {
      const cooldownMs = parseCooldown(bodyText, resp.status);
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + cooldownMs;
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[account-switch] 账号额度/限流，冷却 ${Math.round(cooldownMs / 1000)}s，切换到下一个`);
      }
      // 还有可用账号 → 短退避后重试（会切到下一个号）
      const pool = parseAccounts(env);
      const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
      if (!hasOther) {
        console.log(`[retry] 所有账号均冷却，直接返回上游响应`);
        return resp; // 不空转，把 429/错误返回给客户端
      }
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // 正常响应（200）
    if (resp.ok) {
      if (isStream) return resp; // 流式：直接转发
      return resp;               // 非流式：body 已确认非空响应
    }

    // 其他错误（403/400/401 等）不重试，直接返回
    return resp;
  }
  // 重试次数用完，返回最后一次响应
  return lastResp;
}

// ---------------------------------------------------------------------------
// OpenAI 协议
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API Key 鉴权
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let params;
  try {
    params = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const model = params.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === model);
  const upstreamModel = modelConfig?.upstream || model;

  // 构造上游 body（外部模型 ID 与 Cline 上游模型 ID 分离）
  const body = {
    model: upstreamModel,
    max_tokens: params.max_tokens || params.max_completion_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  // ⚠️ 免费 DeepSeek 通道：非流式请求被上游限流(500 empty response content)，
  //    流式请求正常。所以客户端要非流式时，强制上游走 stream，再聚合返回。
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 客户端要流式：直接透传 SSE
      return streamResponse(resp, model);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合 chunks 再返回
      // ⚠️ 免费通道(deepseek/cline-free)会概率性返回「HTTP200但content全程为空」的流
      //    （100个chunk全是reasoning，无正式content）。这里做内容检测：空则切号重试。
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      retried.data.model = model;
      return jsonResponse(retried.data, 200);
    }
    // 非流式 + 非 deepseek：原逻辑
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    normalized.model = model;
    return jsonResponse(normalized, 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// 把上游 SSE 流聚合成 OpenAI 非流式响应对象
// 用于"客户端要非流式，但上游只能流式"的情况（deepseek 免费通道）
// 额外处理：上游 200 但 content 全空（只有 reasoning）→ 视为坏响应，切号重试
// 由调用方传入"已获取的上游响应"，这里负责聚合 + content 检测 + 空则重试。
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, firstResp) {
  const maxAttempts = 3; // 最多试 3 次（覆盖多账号切换）
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // 需要重新发起上游请求（空响应重试时）
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, true);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    if (ct.includes("text/event-stream")) {
      normalized = await streamToNonStream(resp);
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) normalized = unwrapData(raw);
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ reasoning 兜底标记：content 为空时 streamToNonStream 会把 reasoning 拼进 content，
    //    这里要识别出来，不能把它当成"好响应"。
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // 有正式 content → 好响应
    }
    // content 为空（或只有兜底 reasoning）：如果只有 reasoning，标记当前账号冷却并重试
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 30 * 1000; // 短冷却 30s
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[empty-content] 账号 ${attempt} 返回空 content，冷却 30s，重试第 ${attempt + 2} 次`);
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // 下次循环重新请求（切到下一个号）
      continue;
    }
    // 完全空（连 reasoning 都没有）→ 也重试
    console.log(`[empty-response] 账号 ${attempt} 完全空响应，重试第 ${attempt + 2} 次`);
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // 重试用完仍空：返回最后一次（至少带 reasoning，让客户端看到点东西）
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ 兜底：免费通道偶尔整个流只有 reasoning 没有 content（HTTP 200 但空）。
  //    聚合后发现 content 仍为空且 reasoning 非空时，把 reasoning 拼进 content，
  //    保证客户端（qwenpaw 等）至少能收到可见内容，不会"静默不回复"。
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finishReason || "stop",
      logprobs: null,
      native_finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → 转 OpenAI 格式再转发
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();
  const requestedModel = req.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === requestedModel);
  const upstreamModel = modelConfig?.upstream || requestedModel;

  // Anthropic → OpenAI 消息转换
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: upstreamModel,
    max_tokens: req.max_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  // ⚠️ 免费 DeepSeek 通道：非流式被上游限流，强制上游 stream 再聚合
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合后再转 Anthropic
      // ⚠️ 同样做 content 检测：免费通道会概率性返回"200但content全空"的流，空则切号重试
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200);
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// 剥掉上游 {data:{...}} 包装（上游有时包一层 data）
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE 流式透传（剥 data 包装）
async function streamResponse(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行处理
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              if (normalized && externalModel) normalized.model = externalModel;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// Anthropic SSE：把上游 OpenAI chunk 转成 Anthropic 格式
async function streamResponseAnthropic(upstream) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              const choice = normalized?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              if (delta.content) {
                await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } }) + "\n\n"));
              }
              if (delta.tool_calls && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                  await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.function?.arguments || "") } }) + "\n\n"));
                }
              }
            } catch {}
          }
        }
      }
      // 结束事件
      await writer.write(encoder.encode("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) + "\n\n"));
      await writer.write(encoder.encode("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n"));
    } catch (e) {
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// OpenAI 非流式 → Anthropic 非流式
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const content = choice?.message?.content || "";
  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function handleModels() {
  const list = await refreshModels();
  const payload = list.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cline",
  }));
  return jsonResponse({ object: "list", data: payload }, 200, { "X-Cline2api-Version": VERSION });
}

function getApiKey(request, env) {
  const provided = env.API_KEY;
  // 未配置 API_KEY → 使用内置默认 key
  const expected = provided !== undefined && provided !== null && provided !== "" ? provided : "cline2api-default-key";

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === expected ? expected : null;
  }
  const xKey = request.headers.get("x-api-key");
  return xKey === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

// ===========================================================================
// SOCKS5 出站（可选，Cloudflare Workers 专有）
// ===========================================================================
// 配置 SOCKS5_PROXIES 后，上游请求改走 SOCKS5 隧道：
//   TCP(明文) → SOCKS5 握手/认证 → CONNECT → startTls(按目标域名校验证书)
//   → 手写 HTTP/1.1 收发（支持 chunked / Content-Length / EOF 三种响应体）
// 账号 i 固定绑定代理 i % n：同一账号出口 IP 稳定，便于上游风控白名单。
// 未配置时完全走原生 fetch 直连，行为与之前一致。
//
// 环境变量：
//   SOCKS5_PROXIES         socks5://user:pass@host:port | socks5://host:port | host:port
//                          逗号或换行分隔，可多个
//   SOCKS5_MODE            auto(默认，配了代理就启用) | off(强制直连)
//   SOCKS5_FALLBACK        1(默认)=代理链路异常时回退直连；0=直接报错，不回落
//   SOCKS_TIMEOUT_MS       连接/握手/TLS 超时，默认 10000
//   HEAD_TIMEOUT_MS        上游响应头超时，默认 30000
//   STREAM_IDLE_TIMEOUT_MS 响应体空闲超时，默认 600000（0=不限）
//
// ⚠️ cloudflare:sockets 是 Workers 专有 API：本文件（CF 版）可用，
//    api/index.js（Vercel Edge 版）不支持，故只在 CF 版接入。
// ===========================================================================

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);

const SOCKS5_REP = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

function intEnv(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// host:port | socks5://host:port | socks5://user:pass@host:port
function parseProxyUrl(str) {
  let s = String(str || "").trim();
  if (!s) return null;
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) s = "socks5://" + s;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  const proto = u.protocol.replace(":", "").toLowerCase();
  if (proto !== "socks5" && proto !== "socks5h") return null;
  const port = u.port ? parseInt(u.port, 10) : 1080;
  if (!u.hostname || !Number.isFinite(port)) return null;
  return {
    hostname: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : "",
    password: u.password ? decodeURIComponent(u.password) : "",
  };
}

function upstreamEgressConfig(env) {
  const e = env || {};
  const proxies = String(e.SOCKS5_PROXIES || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProxyUrl)
    .filter(Boolean);
  const mode = String(e.SOCKS5_MODE || "auto").toLowerCase();
  return {
    proxies,
    enabled: mode !== "off" && proxies.length > 0,
    fallback: String(e.SOCKS5_FALLBACK === undefined ? "1" : e.SOCKS5_FALLBACK) !== "0",
    socksTimeoutMs: intEnv(e.SOCKS_TIMEOUT_MS, 10000),
    headTimeoutMs: intEnv(e.HEAD_TIMEOUT_MS, 30000),
    idleTimeoutMs: intEnv(e.STREAM_IDLE_TIMEOUT_MS, 600000),
  };
}

// 账号 i → 代理 i % n
function proxyForAccount(cfg, accountIndex) {
  if (!cfg.enabled) return null;
  const i = Number.isInteger(accountIndex) && accountIndex >= 0 ? accountIndex : 0;
  return cfg.proxies[i % cfg.proxies.length];
}

// 统一上游出口：配了代理走 SOCKS5，否则原生 fetch
async function upstreamFetch(url, init = {}, opts = {}) {
  const env = opts.env || runtimeEnv || {};
  const cfg = upstreamEgressConfig(env);
  if (!cfg.enabled) return fetch(url, init);
  const proxy = proxyForAccount(cfg, opts.accountIndex);
  if (!proxy) return fetch(url, init);
  try {
    const resp = await fetchViaSocks5(url, init, proxy, cfg);
    return resp;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!cfg.fallback) throw new Error(`SOCKS5 出站失败 (${proxy.hostname}:${proxy.port}): ${msg}`);
    console.log(`[socks5] ${proxy.hostname}:${proxy.port} 链路失败(${msg})，回退直连`);
    return fetch(url, init);
  }
}

async function fetchViaSocks5(url, init, proxy, cfg) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("SOCKS5 出站仅支持 https 上游");
  const host = target.hostname;
  const port = target.port ? parseInt(target.port, 10) : 443;
  const socket = await socks5Tunnel(proxy, host, port, cfg.socksTimeoutMs);
  try {
    return await httpOverTlsSocket(socket, target, init, cfg);
  } catch (e) {
    closeQuietly(socket);
    throw e;
  }
}

// 建立 SOCKS5 隧道并在隧道内完成 TLS 握手，返回 TLS socket
async function socks5Tunnel(proxy, host, port, timeoutMs) {
  const socket = connect({ hostname: proxy.hostname, port: proxy.port }, { secureTransport: "starttls" });
  await withTimeout(socket.opened, timeoutMs, "连接 SOCKS5 代理超时", () => closeQuietly(socket));

  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  try {
    await socks5Handshake(reader, writer, proxy, host, port, timeoutMs);
  } finally {
    releaseQuietly(reader);
    releaseQuietly(writer);
  }

  const tls = socket.startTls({ expectedServerHostname: host });
  try {
    await withTimeout(tls.opened, timeoutMs, "隧道内 TLS 握手超时", () => closeQuietly(tls));
  } catch (e) {
    closeQuietly(tls);
    throw e;
  }
  return tls;
}

// SOCKS5 握手 (RFC 1928) + 用户名密码认证 (RFC 1929) + CONNECT
async function socks5Handshake(reader, writer, proxy, host, port, timeoutMs) {
  const r = new SocksReader(reader, timeoutMs);
  const needAuth = Boolean(proxy.username || proxy.password);
  const enc = new TextEncoder();

  await writer.write(new Uint8Array(needAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const hello = await r.readExact(2, "方法协商");
  if (hello[0] !== 0x05) throw new Error(`SOCKS5 协议版本错误: 0x${hello[0].toString(16)}`);
  if (hello[1] === 0xff) throw new Error("SOCKS5 代理不接受任何认证方式");
  if (hello[1] === 0x02) {
    if (!needAuth) throw new Error("SOCKS5 代理要求用户名密码认证，但未配置");
    const user = enc.encode(proxy.username);
    const pass = enc.encode(proxy.password);
    const req = new Uint8Array(3 + user.byteLength + pass.byteLength);
    req[0] = 0x01;
    req[1] = user.byteLength;
    req.set(user, 2);
    req[2 + user.byteLength] = pass.byteLength;
    req.set(pass, 3 + user.byteLength);
    await writer.write(req);
    const auth = await r.readExact(2, "认证");
    if (auth[1] !== 0x00) throw new Error(`SOCKS5 认证失败 (0x${auth[1].toString(16)})`);
  } else if (hello[1] !== 0x00) {
    throw new Error(`SOCKS5 代理要求不支持的认证方式: 0x${hello[1].toString(16)}`);
  }

  // CONNECT：域名模式，由代理解析 DNS
  const hostBytes = enc.encode(host);
  const req = new Uint8Array(7 + hostBytes.byteLength);
  req[0] = 0x05; // VER
  req[1] = 0x01; // CONNECT
  req[2] = 0x00; // RSV
  req[3] = 0x03; // ATYP = 域名
  req[4] = hostBytes.byteLength;
  req.set(hostBytes, 5);
  req[5 + hostBytes.byteLength] = (port >> 8) & 0xff;
  req[6 + hostBytes.byteLength] = port & 0xff;
  await writer.write(req);

  const head = await r.readExact(4, "CONNECT 应答");
  if (head[0] !== 0x05) throw new Error(`SOCKS5 应答版本错误: 0x${head[0].toString(16)}`);
  if (head[1] !== 0x00) {
    throw new Error(`SOCKS5 CONNECT 失败: ${SOCKS5_REP[head[1]] || "rep=0x" + head[1].toString(16)}`);
  }
  const atyp = head[3];
  if (atyp === 0x01) await r.readExact(4 + 2, "CONNECT 绑定地址");
  else if (atyp === 0x04) await r.readExact(16 + 2, "CONNECT 绑定地址");
  else if (atyp === 0x03) {
    const len = await r.readExact(1, "CONNECT 绑定地址");
    await r.readExact(len[0] + 2, "CONNECT 绑定地址");
  } else {
    throw new Error(`SOCKS5 未知地址类型: 0x${atyp.toString(16)}`);
  }
}

// 带缓冲的精确读取（SOCKS5 握手用；握手结束时应无残留字节）
class SocksReader {
  constructor(reader, timeoutMs) {
    this.reader = reader;
    this.buf = new Uint8Array(0);
    this.timeoutMs = timeoutMs;
  }
  async readExact(n, label) {
    while (this.buf.byteLength < n) {
      const { value, done } = await withTimeout(this.reader.read(), this.timeoutMs, `SOCKS5 ${label}读取超时`);
      if (done) throw new Error(`SOCKS5 ${label}: 代理关闭了连接`);
      if (value && value.byteLength) this.buf = concatBytes(this.buf, value);
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

// 在 TLS socket 上完成一次 HTTP/1.1 请求，返回标准 Response（body 为流）
async function httpOverTlsSocket(socket, target, init, cfg) {
  const method = String(init.method || "GET").toUpperCase();
  const path = (target.pathname || "/") + (target.search || "");
  const headers = new Headers(init.headers || {});
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "cline2api-socks5");

  let bodyText = null;
  if (init.body != null && method !== "GET" && method !== "HEAD") {
    bodyText = typeof init.body === "string" ? init.body : await new Response(init.body).text();
  }

  const enc = new TextEncoder();
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${target.host}`];
  for (const [k, v] of headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    lines.push(`${k}: ${v}`);
  }
  const bodyBytes = bodyText == null ? null : enc.encode(bodyText);
  if (bodyBytes) lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  lines.push("Connection: close");

  const writer = socket.writable.getWriter();
  await withTimeout(writer.write(enc.encode(lines.join("\r\n") + "\r\n\r\n")), cfg.headTimeoutMs, "写入上游请求头超时", () => closeQuietly(socket));
  if (bodyBytes) {
    await withTimeout(writer.write(bodyBytes), cfg.headTimeoutMs, "写入上游请求体超时", () => closeQuietly(socket));
  }
  releaseQuietly(writer);

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let headEnd = -1;
  while (headEnd === -1) {
    if (buf.byteLength > 256 * 1024) {
      releaseQuietly(reader);
      throw new Error("上游响应头过大");
    }
    const { value, done } = await withTimeout(
      reader.read(), cfg.headTimeoutMs, "读取上游响应头超时", () => closeQuietly(socket),
    );
    if (done) {
      releaseQuietly(reader);
      throw new Error("上游在返回完整响应头之前关闭了连接");
    }
    if (value && value.byteLength) buf = concatBytes(buf, value);
    headEnd = indexOfDoubleCrlf(buf);
  }

  const parsed = parseHttpHead(new TextDecoder().decode(buf.slice(0, headEnd)));
  const rest = buf.slice(headEnd + 4);

  if (parsed.status < 200) throw new Error(`上游返回临时响应状态码 ${parsed.status}`);

  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(parsed.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "set-cookie") continue;
    outHeaders.set(k, v);
  }

  if (parsed.status === 204 || parsed.status === 304) {
    releaseQuietly(reader);
    closeQuietly(socket);
    return new Response(null, { status: parsed.status, statusText: parsed.statusText, headers: outHeaders });
  }

  const isChunked = /(^|,)\s*chunked\s*(,|$)/i.test(parsed.headers["transfer-encoding"] || "");
  const clenRaw = parsed.headers["content-length"];
  const clen = clenRaw != null ? parseInt(clenRaw, 10) : null;

  const base = new ReadableStream({
    start(controller) {
      if (rest.byteLength) controller.enqueue(rest);
    },
    async pull(controller) {
      try {
        const { value, done } = await readWithIdle(reader, cfg.idleTimeoutMs, socket);
        if (done) {
          releaseQuietly(reader);
          closeQuietly(socket);
          controller.close();
          return;
        }
        if (value && value.byteLength) controller.enqueue(value);
      } catch (err) {
        releaseQuietly(reader);
        closeQuietly(socket);
        controller.error(err);
      }
    },
    cancel() {
      releaseQuietly(reader);
      closeQuietly(socket);
    },
  });

  let body = base;
  if (isChunked) body = base.pipeThrough(chunkedDecodeStream());
  else if (clen != null && Number.isFinite(clen) && clen >= 0) body = base.pipeThrough(fixedLengthStream(clen));

  return new Response(body, { status: parsed.status, statusText: parsed.statusText, headers: outHeaders });
}

function parseHttpHead(text) {
  const lines = text.split("\r\n");
  const m = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})\s*(.*)$/.exec(lines[0] || "");
  if (!m) throw new Error("上游响应头解析失败: " + String(lines[0]).slice(0, 60));
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = headers[k] ? headers[k] + ", " + v : v;
  }
  return { status: parseInt(m[2], 10), statusText: m[3] || "", headers };
}

function fixedLengthStream(total) {
  let remaining = total;
  return new TransformStream({
    transform(chunk, controller) {
      if (remaining <= 0) return;
      const take = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      remaining -= take.byteLength;
      if (take.byteLength) controller.enqueue(take);
    },
  });
}

function chunkedDecodeStream() {
  let buf = new Uint8Array(0);
  let state = "size";
  let remaining = 0;
  const dec = new TextDecoder();
  return new TransformStream({
    transform(chunk, controller) {
      buf = concatBytes(buf, chunk);
      for (;;) {
        if (state === "done") return;
        if (state === "size") {
          const idx = indexOfCrlf(buf);
          if (idx === -1) return;
          const line = dec.decode(buf.slice(0, idx)).trim();
          buf = buf.slice(idx + 2);
          const size = parseInt(line.split(";")[0].trim(), 16);
          if (!Number.isFinite(size) || size < 0) throw new Error("chunked 解码失败: 非法块长度");
          if (size === 0) {
            state = "trailer";
            continue;
          }
          remaining = size;
          state = "data";
        } else if (state === "data") {
          if (buf.byteLength < remaining) return;
          controller.enqueue(buf.slice(0, remaining));
          buf = buf.slice(remaining);
          remaining = 0;
          state = "break";
        } else if (state === "break") {
          if (buf.byteLength < 2) return;
          buf = buf.slice(2);
          state = "size";
        } else { // trailer
          const idx = indexOfCrlf(buf);
          if (idx === -1) return;
          const line = dec.decode(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (line === "") {
            state = "done";
            return;
          }
        }
      }
    },
  });
}

// 响应体读取：空闲超过 idleMs 视为链路卡死（idleMs <= 0 表示不限）
async function readWithIdle(reader, idleMs, socket) {
  if (!idleMs || idleMs <= 0) return reader.read();
  return withTimeout(reader.read(), idleMs, "上游响应体空闲超时", () => closeQuietly(socket));
}

function withTimeout(promise, ms, message, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout();
        } catch (e) {
          /* ignore */
        }
      }
      reject(new Error(message || "操作超时"));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function concatBytes(a, b) {
  if (!a || !a.byteLength) return b;
  if (!b || !b.byteLength) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function indexOfCrlf(buf) {
  for (let i = 0; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function indexOfDoubleCrlf(buf) {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function releaseQuietly(r) {
  try {
    if (r && r.releaseLock) r.releaseLock();
  } catch (e) {
    /* ignore */
  }
}

function closeQuietly(s) {
  try {
    if (s && s.close) s.close();
  } catch (e) {
    /* ignore */
  }
}
