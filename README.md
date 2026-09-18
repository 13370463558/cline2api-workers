# Cline2API · Cloudflare Workers 版

把 Cline（https://cline.bot）的白嫖模型能力转成 OpenAI 兼容 API，部署在 Cloudflare Workers 上，免费、无服务器、无需本地运行。

> 逆向自 https://github.com/luawei1/cline2api
>
> （Go 版代理），重写为纯 JS 的 Worker。

---

## 一、准备工作：获取 Cline 的 refreshToken ⭐（最关键）

要调用 Cline 的 API，需要一个 **refreshToken**（相当于 Cline 账号的"长期钥匙"，用它换每次请求用的 accessToken）。

本仓库提供 **两个获取方式**，任选其一：

### 方式①：命令行脚本（推荐，本仓库自带 `cline_oauth.py`）

脚本会启动 Cline 官方的 **WorkOS 设备授权码流程**，你在浏览器里登录一次即可，剩余全部自动：

```bash
# 1. 运行脚本，生成授权链接
python3 cline_oauth.py

# 2. 脚本会打印一个链接，类似：
#    https://authkit.cline.bot/device?user_code=XXXX-XXXX
#    在浏览器打开，用 Google / GitHub / 邮箱登录授权

# 3. 授权完成后，脚本自动轮询并打印 refreshToken
```

> 脚本内部做的（逆向自 auth.go）：
> 1. `POST api.workos.com/.../authorize/device` → 拿 device_code + 授权链接
> 2. 轮询 `api.workos.com/.../authenticate` → 授权成功后拿 WorkOS access_token
> 3. `POST api.cline.bot/api/v1/auth/register` → 用 WorkOS token 换 Cline 的 refreshToken

### 方式②：GitHub Actions 工作流（无需本地环境，手机上也能操作）⭐

仓库自带 `.github/workflows/get-token.yml` 工作流，**在手机上也能跑**：你只需在手机浏览器点开 TG 推送的授权链接完成登录，脚本在云端自动轮询，拿到的 refreshToken **只私发到你的 Telegram，绝不进 Actions 日志**。

**第一步：配置 TG 变量（强制，不配不运行）**

在仓库 **Settings → Secrets and variables → Actions** 里添加两个 secret：
- `TG_BOT_TOKEN`：你的 Telegram Bot 的 token
- `TG_CHAT_ID`：接收消息的 chat_id（你自己的 id）

> 缺任一个，工作流都会直接报错退出，不进入授权流程。

**第二步：手动触发**

1. 进入仓库 **Actions** 页 → 点击左侧 **「获取 Cline refreshToken」**
2. 点右边 **Run workflow** → 可选手动填授权等待秒数（默认 300）→ 运行
3. Telegram 会收到**授权链接 + 设备码** → 用手机/电脑浏览器打开，Google/GitHub/邮箱 登录授权
4. 授权成功 → TG 收到 **`refreshToken`**，直接复制填入 CF Worker 机密变量即可

**安全说明：**
- 🔒 `refreshToken` 与账号**邮箱都不会出现在 Actions 日志**（`::add-mask::` 双重打码 + 只推 TG）
- 🔁 工作流运行完自动**清理旧运行记录，只保留最新 1 条**
- ⏱️ 授权链接推送 TG 失败会中止，宁可失败也不把 token 写进日志

### 方式③：在原版 Go 程序里提取（如果你已经用过 cline2api）

1. 下载原版 [cline2api releases](https://github.com/luawei1/cline2api/releases) 的运行文件
2. 运行 `./cline-proxy --login`，浏览器登录 Cline
3. 打开 `~/.cline2api/.cline-accounts.json`，找到 `refreshToken` 字段，复制它

---

## 二、部署到 Cloudflare Workers

> ⚠️ **推荐方式：复制代码粘贴部署，不要用 Git 关联仓库部署。**
> 实测 GitHub 关联 CF 部署（Git 集成）容易因入口文件/构建环境问题导致部署失败，
> 且改环境变量后不会自动生效。用下方「复制代码」方式最稳、最快。

### 需要的东西

- 一个 Cloudflare 账号（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`

### 部署步骤（复制代码版，推荐 ✅）

1. 打开本仓库 `worker.js`，**全选复制全部代码**
2. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **创建 Worker**
3. 名字填 `cline2api`（可自定义）→ **部署**
4. 进入 Worker → **编辑代码** → 删除默认代码，**粘贴**刚才复制的 `worker.js` 全部内容 → **部署**（右上角）
5. **配置环境变量**（重点 ⚠️）：
   - Worker → **设置** → **变量和机密** → **添加**：
     - **机密(Secret)**：`CLINE_REFRESH_TOKEN` = 第一步拿到的 refreshToken（必填）
       - **支持多账号**：一行一个 token，见下文「多账号」章节
     - **机密(Secret)**：`API_KEY` = 你的访问密钥，例如 `sk-cline-xxx`（建议必填，可自定义）
   - ⚠️ **保存后必须再点一次「部署」触发重新编译**，变量才会生效！
6. 完成！你的 API Base URL 就是 `https://cline2api.<你的子域>.workers.dev`

> 💡 验证环境变量是否生效，访问诊断端点：
> ```bash
> curl https://cline2api.<你的子域>.workers.dev/v1/health
> ```
> 返回 `api_key_configured: true` 即表示变量已生效，`account_count` 显示已配置的账号数量。

### 需要的东西&环境变量说明

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `CLINE_REFRESH_TOKEN` | 机密 Secret | ✅ | Cline 账号 refreshToken，**一行一个，支持多账号** |
| `API_KEY` | 机密 Secret | 建议 | 客户端访问密钥；不设则用默认 `cline2api-default-key` |

> 变量名必须**完全一致**（全大写、无空格）。修改后**务必保存并重新部署**才会生效。

### 🔁 多账号（额度用完自动切号）⭐

一个账号的免费额度/限流用完时，想切下一个号？不用改任何东西，**在 `CLINE_REFRESH_TOKEN` 里一行填一个 token 即可**：

```
第一个账号的refreshToken
第二个账号的refreshToken
第三个账号的refreshToken
```

**工作机制：**
- 🔄 **账号池轮询**：请求轮流使用不同账号（round-robin），分散单账号压力
- ⚡ **额度用完/限流自动切号**：某账号触发 429（`Daily free limit reached`）或空响应，
  **解析上游冷却提示**（如 `Try again in 2h 51m`），按实际时长冷却该账号并切换到下一个，同一请求换号重试
- 🚫 **失效自动跳过**：刷新失败的账号会被跳过，不阻塞
- ✅ **独立缓存**：每个账号各自的 accessToken 独立缓存，互不影响
- 🛡️ **全部冷却不空转**：所有账号均冷却时直接返回上游响应，不盲目重试
- 单账号时完全兼容，原样工作

**验证：** 部署后访问 `/v1/health`，返回 `account_count` 即当前账号数量。

### 验证部署

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/models \
  -H "Authorization: Bearer <你的API_KEY>"
```
应返回模型列表。再发一次聊天：

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"poolside/laguna-s-2.1:free","messages":[{"role":"user","content":"你好"}]}'
```

---

## 三、部署到 Vercel（可选 ✅ 推荐备一条）

同一份代码可以**同时**部署到 Cloudflare Workers 和 Vercel，互为备份：

- `worker.js` → Cloudflare Workers 入口
- `api/index.js` → Vercel Edge Function 入口（逻辑与 `worker.js` 完全一致，仅入口/区域声明不同）
- `vercel.json` → 路由重写，把 `/v1/*` 指到 `/api/index`，**不用改**

> 💡 **什么时候值得加一条 Vercel**：CF Workers 域名对 `User-Agent` 挑得凶（非浏览器 UA 直接 `1010`），
> 而 Vercel 域名不挑 UA（curl / python / SDK 默认 UA 都能直连）。如果你的客户端不好自定义请求头，
> 用 Vercel 那条会更省事。

### 需要的东西

- 一个 Vercel 账号（Hobby 免费档即可：[vercel.com/signup](https://vercel.com/signup)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`
- **不需要**改代码、不需要 `package.json`、不需要构建命令（Framework Preset 选 `Other` 即可）

### 方式①：Vercel CLI 部署（最快）

```bash
# 1. 安装 CLI（已装可跳过）
npm i -g vercel

# 2. 登录
vercel login

# 3. 拉代码
git clone https://github.com/pingmike2/cline2api-workers.git
cd cline2api-workers

# 4. 首次关联项目（交互里选 Create new project，Framework Preset 选 Other）
vercel link

# 5. 配置环境变量（持久化到项目，多账号 refreshToken 一行一个）
vercel env add CLINE_REFRESH_TOKEN production
vercel env add API_KEY production

# 6. 部署到生产
vercel --prod
```

部署完成后地址是 `https://<项目名>.vercel.app`。

> ⚠️ 两个容易踩的点：
> - 环境变量要用 `vercel env add` 写入项目；`vercel --prod --env X=Y` 只对**当次部署**生效，不写进项目配置
> - **改过环境变量后必须重新 `vercel --prod`**，运行时才会读到新值

### 方式②：Dashboard 关联 Git（推送后自动部署）

1. 打开 [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → 选 `pingmike2/cline2api-workers`
2. **Production Branch 选 `main`**（本仓库只有 main 一条分支，CF 和 Vercel 两份代码都在里面）
3. **Framework Preset 选 `Other`**，Root Directory 保持 `.`（⚠️ 不要填 `api`）→ Build / Output 全部留空
4. **Environment Variables** 添加：
   - `CLINE_REFRESH_TOKEN` = 你的 refreshToken（必填，一行一个支持多账号）
   - `API_KEY` = 你的访问密钥（可选，不设则用默认 `cline2api-default-key`）
   - 环境至少勾 **Production**（想在预览环境测可再勾 Preview）
5. **Deploy**

之后 push 到 `main` 会自动部署；同样地，**改了环境变量要在 Deployments 里点一次 Redeploy** 才会生效。

### 验证部署

```bash
# 健康检查（无需鉴权）
curl https://<项目名>.vercel.app/v1/health
```

返回 `{"ok":true,"version":"1.1.8","model":"cline-free/deepseek-v4.1-flash",...}` 即成功。

```bash
# 聊天测试
curl https://<项目名>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"model":"cline-free/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

### ⚠️ Vercel 部署的坑（实测）

1. **Deployment Protection 会挡住域名**：默认开启时，`项目名-账号.vercel.app`、
   `项目名-<hash>-账号.vercel.app` 这类域名会被 Vercel SSO 拦截（返回 302 跳
   `vercel.com/sso-api`），**只有生产别名 `项目名.vercel.app` 是公开可访问的**。
   如果三个域名全是 302，去 **Settings → Deployment Protection** 关掉 Vercel Authentication。
2. **只跑美区**：`api/index.js` 里写死了 `regions: ["iad1", "sfo1"]`（美国西部/东部）。
   要换区域就改这一行；去掉 `regions` 则跟随 Vercel 默认调度。
3. **Hobby 免费档有商用限制**，且无 SLA，适合自用/备用。
4. **Vercel 域名不挑 UA**（实测 curl / python-urllib 直连 200），CF Workers 域名则必须带浏览器 UA，
   否则 `error code: 1010`。两边都部署时，客户端可优先指向 Vercel 域名。

---

## 四、在 AgentScope 平台调用（模型接入）

把该 Worker 当作 OpenAI 兼容 API 接入 **AgentScope（QwenPaw / qwenpaw.agentscope.io）** 时：

### ⚠️ 关键：直接用 Workers 域名，不要用自定义域名

- **用 `https://cline2api.<你的子域>.workers.dev/v1`** 作为模型 **Base URL / API Base**。
- **不要用绑定的自定义域名**（如 `api.llm.xxx.com`）：AgentScope 平台对接时，
  自定义域名可能因证书/路由/鉴权头处理问题导致调用失败或鉴权不过，
  直接用 Workers 官方域名最稳。

### AgentScope 里怎么配（OpenAI 兼容模式）

- **API Base / Base URL**：`https://cline2api.<你的子域>.workers.dev/v1`
  （部分平台要求不带 `/v1` 的填写为 `https://cline2api.<你的子域>.workers.dev`，按平台提示试）
- **API Key**：填你设置的 `API_KEY` 值（如 `sk-cline-xxx`）
- **Model**：`deepseek/deepseek-v4-flash`（默认）或 `poolside/laguna-s-2.1:free`、`zai/glm-5.2`（付费，约 $0.0008/次）。
  `depth/deepseek-v4-flash` 是 `deepseek/deepseek-v4-flash` 的拼写别名，同款免费，任意前缀均可。

> 若 AgentScope 平台走的标准 OpenAI SDK，直接指定上述 base_url + api_key 即可。
> 若测试报 401，请确认 `API_KEY` 变量已在 CF 配置并重新部署过。

### ⚠️ 高级配置：给模型加自定义请求头（防 Workers 返回 1010）

**重要**：Cline 的 Workers 网关对**非浏览器 UA 的请求**可能直接拦截返回
**`1010`**（浏览器 / 非 Cloudflare Workers 页面访问报错）。你在 AgentScope 里配完
Base URL / API Key / Model 后，如果**一调用就报 1010 或连接失败**，十有八九是
请求头里的 `User-Agent` 太"机器"（如 curl / python-httpx / 平台默认 SDK UA）被网关挡了。

**解决办法**：在**模型的「高级设置 / 自定义请求头」**里加一个浏览器 UA：

```text
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**AgentScope 平台具体操作**：模型配置页 → 找到该模型的**高级设置 / 自定义 Headers（请求头）**区域，
新增一条请求头：
- 键（Key）：`User-Agent`
- 值（Value）：上面那串 Chrome 浏览器 UA

保存后重试即可，Workers 就会把它当成正规浏览器流量放行。

> 💡 记一下：**任何平台接这个 Worker 报 1010，第一反应就是补这个浏览器 UA 请求头**，
> 因为网关只按 UA 判是不是浏览器，跟你的 API Key 正不正确无关。加完 UA 还报 401 才去查 Key。

---

## 五、使用

```text
Base URL: https://cline2api.<你的子域>.workers.dev/v1   （或 https://<项目名>.vercel.app/v1）
API Key:  <你设置的 API_KEY>
Model:    cline-free/deepseek-v4.1-flash   （默认，免费）
```

兼容 OpenAI 客户端（`/v1/chat/completions`）和 Anthropic 客户端（`/v1/messages`，自动转换）。

### 可用模型（实测）

| 模型 ID | 结果 |
|---|---|
| `cline-free/deepseek-v4.1-flash` | ✅ **免费可用**（默认；逆向自官方插件 recommended-models 免费通道，无需 credits） |
| `deepseek/deepseek-v4-flash` | ✅ **免费可用**（需完整 Cline 客户端头 + 强制 stream，已修复） |
| `depth/deepseek-v4-flash` | ✅ **免费可用**（`deepseek/deepseek-v4-flash` 的拼写别名，同款，前端任一前缀均可） |
| `poolside/laguna-s-2.1:free` | ✅ **免费可用** |
| `zai/glm-5.2` | ✅ **可用（付费）**，走 Cline 系统凭证，约 $0.0008/次 |
| `z-ai/glm-5.3-flash` | ✅ **免费可用**（2026-09-19 修复，见下方 v1.1.8 说明） |
| `deepseek/deepseek-v4.1-flash` | ❌ **402 insufficient_credits**（付费档，余额不足；免费请用 `cline-free/` 前缀） |
| `cline-free/glm-5.2` | ❌ **已下架**（上游 404 `model not found`，2026-08-06 实测） |
| `cline-pass/*` | ❌ 403，需付费 cline-pass 订阅 |

> ⚠️ **2026-09-19 更新（v1.1.8）：剥离 `max_tokens`，解锁更多免费模型** ⭐
> - **根因**：上游对免费模型的请求体只要带 `max_tokens` 字段，一律返回
>   500 `{"error":"empty response content"}`——与请求头无关（指纹头齐全也照炸），
>   是请求体字段触发。不带该字段即 200。
> - **修复**：worker 构造上游 body 时不再注入 `max_tokens`（客户端传了也直接忽略）。
>   已知代价：上游按自己节奏生成，客户端无法靠 `max_tokens` 提前截断输出。
> - **收益**：`z-ai/glm-5.3-flash`（免费、带 reasoning）实测 200 可用；
>   其余 `:free` 后缀模型同理受益——只要上游模型列表里标注免费的，理论上都能通，
>   以 `GET /v1/models` 实际返回为准。GUI 的"测试模型"功能（固定发 `max_tokens:1`）
>   之前必 500，现在也能正常测延迟了。

> ⚠️ **2026-09-16 更新：接入 DS V4.1 Flash 免费通道** ⭐
> - **`cline-free/` 前缀 = Cline 官方插件免费通道**。官方插件（VS Code / JetBrains）通过
>   `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` 拉取模型列表，返回体里的
>   **`free` 数组**就是免 credits 的模型，其中 `cline-free/deepseek-v4.1-flash` 为当前主力。
> - **关键区别**：不带前缀的 `deepseek/deepseek-v4.1-flash` 是**付费档**（余额不足直接 402
>   `insufficient_credits`）；只有 `cline-free/deepseek-v4.1-flash` 走官方免费额度。
> - worker 每次刷新模型列表时会**同时拉取 `recommended-models`**，把 `free` 数组合并进模型池，
>   官方日后调整免费模型可自动跟进，无需改代码。
> - `forceStream`（非流式强制走上游 stream）已扩展到 `cline-free/` 与 `cline-pass/` 前缀。

> ⚠️ **2026-08-06 更新**：
> - **`cline-free/glm-5.2` 上游已下架**：该免费模型名在 Cline 上游返回 404 `model not found`（非请求头问题，
>   与 deepseek 同款 Cline 指纹头仍返回 200）。同模型的付费通道 `zai/glm-5.2` 可用（约 $0.0008/次，
>   走 Cline 系统凭证），`cline-pass/glm-5.2` 需订阅返回 403。
> - 若你的 AgentScope 里还配着 `cline-free/glm-5.2`，请改配 `deepseek/deepseek-v4-flash`（免费）或 `zai/glm-5.2`（付费）。
>
> ⚠️ **2026-08-05 修复记录**：
> - **403 "only available via Cline product surfaces"**：worker 请求头太精简，被官方识别为第三方调用。
>   修复：补齐完整 Cline 客户端指纹头（`User-Agent: Cline/3.0.47`、`HTTP-Referer`、`X-CLIENT-TYPE: cline-sdk`、
>   `X-CLIENT-VERSION`、`X-PLATFORM` 等），`deepseek/deepseek-v4-flash` 和 `cline-free/glm-5.2` 恢复可用。
> - **非流式 500 "empty response content"**：上游对免费通道（deepseek + cline-free）的非流式请求限流，但流式正常。
>   修复：客户端要非流式时，worker 强制上游走 stream，聚合 chunks 后返回非流式响应。
> - **429 "Daily free limit reached"**：不是 bug，是**账号每日免费额度**用完（`Try again in Xh Xm`）。
>   这是 Cline 官方对免费模型的日配额，等冷却结束自动恢复；多账号可缓解（`CLINE_REFRESH_TOKEN` 多行填多个 token）。
> - **多账号 429 自动切号**：429 限流时自动解析上游冷却时长（如 `Try again in 2h 51m`），
>   冷却该账号并切换到下一个可用账号重试同一请求；所有账号均冷却时直接返回上游响应，不空转。

---

## 六、项目结构

```
.
├── worker.js               # Cloudflare Workers 入口（CF 部署核心）
├── api/index.js            # Vercel Edge Function 入口（Vercel 部署核心，与 worker.js 同源）
├── vercel.json             # Vercel 路由重写：/v1/* → /api/index
├── wrangler.toml           # CF 命令行部署配置（用复制代码方式可忽略）
├── cline_oauth.py          # 获取 CLINE_REFRESH_TOKEN 的脚本 ⭐
├── .github/workflows/
│   └── get-token.yml       # 手动运行的工作流：在 TG 上获取 refreshToken
├── README.md               # 本文件
└── README-vercel.md        # Vercel 版补充说明（历史文档，主体见本文件第三章）
```

> ⚠️ `worker.js` 与 `api/index.js` **逻辑同源**：改功能时两份都要同步改（否则 CF 与 Vercel 行为会不一致）。

## 七、获取 refreshToken 常见问题

**Q: 谁能看到我的 refreshToken？**
→ 只有你。它存在 CF Workers 的**机密变量**里（加密存储，代码里看不到、日志里不显示）。不要把 `wrangler.toml` 里的变量跟真实 refreshToken 混写，机密务必用 `wrangler secret` 或 Dashboard 的"机密"类型。

**Q: refreshToken 会过期吗？**
→ 会，但 Cline 的 refreshToken 有效期较长。如果将来请求返回 401/403 token 失效，重新跑 `cline_oauth.py` 拿新的即可。

**Q: 免费额度够用吗？**
→ `cline-free/deepseek-v4.1-flash`（默认）、`deepseek/deepseek-v4-flash`、`poolside/laguna-s-2.1:free` 和 `z-ai/glm-5.3-flash` 都是免费模型。
   deepseek 有**每日免费额度**（用尽返回 429 "Daily free limit reached"，数小时后恢复）；
   多账号可缓解（`CLINE_REFRESH_TOKEN` 多行填多个 token，额度用尽自动切号）。
   `zai/glm-5.2` 为付费模型（约 $0.0008/次），走 Cline 系统凭证，无每日额度限制。

---

## 许可

本项目基于 [luawei1/cline2api](https://github.com/luawei1/cline2api)（Go 版）逆向重写，遵循其原许可证：

**MIT License** © 2026 [luawei1](https://github.com/luawei1)（原版）& [pingmike2](https://github.com/pingmike2)（Workers 版）· 详见 [LICENSE](LICENSE)

Workers 版改动部分同样以 MIT 协议开源。
