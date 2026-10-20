# magpie-officeace-auth

把本机 **OfficeAce** 桌面端接成 magpie 的一个 OpenAI 兼容供应商。

有两条链路，按模型名选；**默认走直连**：

| 模型名 | 链路 | 说明 |
| --- | --- | --- |
| `officeace/<模型>` | **直连网关** | 主力。原生 OpenAI 协议，真 SSE、原生 tool_calls、reasoning。 |
| `officeace/agent` | OfficeAce 智能体 | 兜底。等价于在桌面端界面里对话。 |
| `officeace/agent:<智能体>` | 指定智能体 | 例如 `officeace/agent:assistant` |
| `officeace/agent:<智能体>@<模型>` | 智能体 + 指定后端模型 | 例如 `officeace/agent:office@glm-5.2` |

## 需要打开 OfficeAce 吗？

**直连链路不需要。** 它只做两件事：读磁盘上那份网关凭据、打公网网关。
不碰 `127.0.0.1:3004`，不碰 OfficeAce 进程。

实测过最极端的情况 —— 模拟一台「OfficeAce 从没写过任何本机文件」的机器
（`routing_state` 和 `session.cookie` 都指向不存在的路径）：

```
凭据来源 : baked
authorize: success
直连 status = 200 | usage = {"prompt_tokens":18, ...}
回答 = "OK"
```

也就是说：**装过 OfficeAce（哪怕只装过一次，凭据有兜底常量）、或者手动设一个
`MAGPIE_OFFICEACE_GATEWAY_AUTH`，就能一直用，软件不用开着。**
`tools/test-standalone.mjs` 就是跑这个隔离态验证的。

| | 需要 OfficeAce 在跑？ | 需要登录态？ |
| --- | --- | --- |
| `officeace/<模型>`（直连） | ❌ 不需要 | ❌ 不需要 |
| `officeace/agent`（兜底） | ✅ 需要（本地 API 3004） | ✅ 需要 `oc_sid` |

唯一的不确定项：网关凭据目前看是**固定值**（磁盘上那份和内置兜底完全一致，
跨整个会话没变过），但它终究是 OfficeAce 下发的。万一哪天上游把它作废了，
直连会开始报 401/403 —— 那时把 `MAGPIE_OFFICEACE_GATEWAY_AUTH` 换成新值即可。
换机器也建议显式设一次这个变量，别依赖兜底常量。

---

## 模型清单：为什么不是 OfficeAce 界面上那 4 个？

因为两条链路的**数据源不同**：

| | 来源 | 数量 |
| --- | --- | --- |
| OfficeAce 界面 | `GET /api/maas-models` 里 `enabled: true` 的 | 4 |
| 直连网关 | `GET <gateway>/models` 的**全量** | 21+ |

网关那份里有 `glm-5.3-test`、`glm-5.2-zx`、`deepseek-v4.1-flash-bnt` 这类
实验/内部版本 —— 界面不列出来是有道理的。

**默认行为：只暴露 OfficeAce 启用的那几个**（问得到实时清单就用实时的，
问不到就用内置兜底），和界面一致。想看全部：

```bash
MAGPIE_OFFICEACE_MODELS=all            # 网关全量
MAGPIE_OFFICEACE_MODELS=glm-5.2,glm-5.3 # 只要这几个
```

## 思考档位

网关**原生支持** `reasoning_effort`，合法取值（传错会 400，报错里带着枚举）：

```
none, minimal, low, medium, high, xhigh, max
```

实测同一道题经插件的 `reasoning_tokens`：

| 档位 | `glm-5.2` | `deepseek-v4.1-flash` |
| --- | --- | --- |
| `none` | **0**（不思考） | 152 |
| `low` | 590 | 116 |
| `max` | 927 | 65 |

**档位是看模型的**：`glm-5.2` 严格听话（`none` 真的不思考，`max` 想得最多）；
`deepseek-v4.1-flash` 基本不理会这个参数 —— 这是上游模型自己的行为，不是插件的问题。
选档位前建议用 `bun tools/probe-gateway.mjs <模型>` 先量一下。

插件按 magpie 的约定声明（`variants` 键即档位名，值带 `reasoningEffort`），
magpie 会把选中的档位作为 `reasoning_effort` 放进请求体 —— 插件原样透传。
对不自带推理的模型，插件会**主动摘掉**这个字段，免得被网关 400。

> **注意**：目前 magpie 没有把本插件声明的 `variants` 自动认成
> 「该模型已有的档位」（`magpie model efforts officeace/glm-5.2` 会说
> `no reasoning levels known`），但**档位列表已经正确存进 magpie 的模型库**。
> 如果界面上看不到档位选择，用 magpie 自己的命令登记一次即可：
>
> ```bash
> magpie model efforts officeace/glm-5.2 none,minimal,low,medium,high,xhigh,max
> magpie model efforts officeace/glm-5.2            # 读回确认
> ```

OfficeAce 界面上的 **快速 / 均衡 / 极致** 就对应这套档位（快速 ≈ `none`/`minimal`，
均衡 ≈ `medium`，极致 ≈ `high`/`max`）。界面上那些 `0.70x / 0.27x` 是 OfficeAce
自己的积分倍率，属于它的云端业务逻辑，网关这边没有这个概念。

**magpie 下拉里看到 8 项（Default / Off / Minimal / Low / Medium / High / Xhigh / Max）是
对的**：前 7 项就是网关枚举，`Default` 是 magpie 自己加的「不传该字段」项
（让模型用自己的默认值）。个别模型不显示档位时，用下面的
`magpie model efforts` 命令补登记一次即可。

## 界面上的「思考模式」在哪

选好模型后在模型设置里可以看到 `none / minimal / low / medium / high / xhigh / max`
那排档位。如果某个模型没显示，用上面那条 `magpie model efforts` 命令补一次。

---

## 它是怎么登录的

magpie 的插件登录方式只有两种：`oauth` 和 `api`（本机 29 个用 oauth、6 个用 api）。
本插件**两种都申报了**，默认用 **`oauth`**（列表第一位）：

| 方法 | 流程 | 适用 |
| --- | --- | --- |
| **oauth**（默认） | 本机会话在 → 秒成功不弹浏览器；会话不在 → 插件自己开 `127.0.0.1` 登录页（链接同时写日志和临时文件），页面自动检测到本机会话即完成，也可在页面粘 `oc_sid`；整条流程在 `authorize()` 内阻塞完成，**不返回浏览器结果** | 日常。magpie 会**自动持久化** `accountId`，账号名一劳永逸，不再显示「API key …末四位」 |
| **api**（备用） | 老流程：`auto` 自动读本机或粘贴 `oc_sid`；`accountId` 不会自动落库（插件 loader 里补写了） | 兼容旧行为 |

> **为什么 oauth 方法不返回浏览器结果？** 实测本版 magpie 桌面端对外部插件
> `authorize()` 返回的 `{type:"browser", url, callback}` 有 bug：callback 在落库时
> 丢失，完成阶段直接报 `s.a.callback is not a function`（内置插件和宿主同进程
> 所以没事）。所以本插件的整个交互都放在 `authorize()` 内部完成，返回只可能是
> success/failed，避开这条坏路径。对应现象：「已打开登录页」出现但浏览器没动静，
> 然后弹「登录未完成」。
>
> **排查辅助**：登录流程每一步都追加写进 `%TEMP%\magpie-officeace-oauth.log`
> （本机会话读取结果、回环页地址、开浏览器尝试、超时/完成原因）。
> magpie GUI 里看不到插件日志时，直接把这个文件发出来即可定位。
> 另外：**改了插件代码后 magpie 不会热更**——更新后必须彻底退出 magpie
> （托盘图标退出，不是关窗口）重新打开，或在该插件上 off + on。

「oauth 风格」而不是真 OAuth 的原因：OfficeAce 的真登录（华为 OAuth2）在桌面端
完成，凭据由它自己维护轮换。插件借用 magpie 的 oauth 管道做「回调式收据」，
体验和 OAuth 一致，但没有浏览器驱动、token 刷新那些脆弱环节。

而其中其实有**两套凭据，各干各的活**：

| 凭据 | 从哪来 | 用在哪 | 需要 App 在跑 |
| --- | --- | --- | --- |
| `oc_sid` 会话 Cookie | `~/.office-claw/session.cookie`（`OC-DPAPI-1` + DPAPI，用 PowerShell `ProtectedData.Unprotect` 解出 `{value, expires}`） | 本地 API `127.0.0.1:3004`：智能体兜底链路、积分、签到 | ✅ |
| `Authorization: Basic <base64(ak:sk)>` | `~/.office-claw/.jiuwenclaw/config/routing_state/users/*/models.json` 的 `custom_headers.Authorization` | 公网 MaaS 网关：**所有真正的模型请求** | ❌ |

也就是说：**模型走第二套、不需要登录；登录态只影响积分/签到和智能体兜底。**

`authorize()` 的行为：留空就自动读本机，读到了就向 `/api/islogin` 问一下
`userName`（顺便看 `needsReauth`），把账号名记进 magpie。

> 小坑：magpie **不会**把 `api` 类方法 `authorize()` 返回的 `accountId` 落库
> （`oauth` 类的会），得插件自己在 `loader` 里调一次 `client.auth.set`。
> 不做的话账号那一栏永远显示 `API key …末四位`。
> **选上面那个 `oauth` 方法就没有这个坑**——magpie 直接落库，loader 里那套
> 补写逻辑只是给 `api` 方法兜底。

### 为什么不用 oauth

OfficeAce 的登录（华为 OAuth2）是在桌面端完成的，凭据也由它自己维护。
插件再实现一遍 OAuth 意味着驱动浏览器、处理回调、自己管 token 刷新 —— 又脆又没必要。
直接复用桌面端已经维护好的会话，反而更稳：App 换号/续期，插件自动跟上。

## 积分余额与每日签到

OfficeAce 的账号体系里有一套积分和一个每日签到活动。接口从渲染层逆向出来
（`app.asar` 的 `SubscriptionStateProvider`）：

| 接口 | 作用 |
| --- | --- |
| `GET /api/subscription/current` | 余额：`totalCredits` / `usedCredits` / `unlimitedCredits` / `plan` / `bonusSkus` |
| **`POST /api/subscription/claim-bonus`** | **签到领积分**，返回 `{ bonusSkus: [...] }` |
| `GET /api/subscription/gate-config` | 功能开关 |
| `GET /api/subscription/usage` | 按小时/天的积分消耗曲线 |

前端对 `claim-bonus` 是「**每小时试一次**」——服务端幂等，没得领就回空数组，
所以补签可以随便调。插件把它接成 magpie 的原生钩子：

- `usage()` → Usage 卡片：积分余额（带剩余百分比进度条）、每日签到状态、
  其他奖励活动、套餐与到期日
- `checkin()` → 由 magpie 的 **Settings → Usage → Plugins → Daily check-in**
  开关调度（`package.json` 里 `magpie.options.signin = true`）

实测（本机账号）：

```
积分余额: 5222 / 5500 积分 (used=5%)
每日签到: 今日已签 ✓ +1000
新用户专属福利: +4000 积分
套餐: trial · 至 2026-11-19
```

> **注意**：积分/签到走的是 OfficeAce 本地 API（`127.0.0.1:3004`），
> **需要 OfficeAce 在运行**。这点和模型直连不同 —— 模型那条路不需要开 App。
> App 没运行时 `usage` 会返回 `error`、`checkin` 会抛错让 magpie 稍后重试，
> 都不会谎报成功。
>
> 另外 OfficeAce 自己也有一个每小时跑的自动签到。所以 App 开着的时候，
> 通常它已经替你签过了；插件的 `checkin` 是让 magpie 这条线也能补上。

### 签到背后有一条「云直连接口」（不需要 App，只在能做签名时成立）

本地 API 的 `/api/subscription/*` 只是代理。从 `packages/api/dist/index.js`
（`FS.cloudFetch` / `claimBonus`）可以直接读出真实调用链：

```
POST/GET {apigOrigin}/v1/subscription          # 余额 (带 x-subscription-type: v2)
POST     {apigOrigin}/v1/subscription/bonus/claim   # ← 签到本体
GET      {apigOrigin}/v1/subscription/resources?type=OfficeAce&is_subscribed=true
GET      {apigOrigin}/v1/model-token-rates
GET      {apigOrigin}/v1/subscription/usage?sku_attr_code=officeace_points&...

apigOrigin = routing_state 里 huawei_maas provider 的 baseUrl 的 origin
             (就是 modelgw 那个域; 兜底 agentarts.cn-southwest-2.myhuaweicloud.com
              / versatile.cn-north-4.myhuaweicloud.com)
```

**认证不是模型网关那套 Basic 头**，而是华为云的 **`V11-HMAC-SHA256` 请求签名**：
`{accessKey, secretKey, securityToken(即 STS), projectId}`（会话里 `kind:"signed"`
的那组凭据），projectId 还要现查（`Cu()` 会先取 project 列表再解析，缓存一小会儿）。

所以「签到必须开软件」不是接口本身的性质，是**签名凭据**的问题：
- 开 App 时，本地 API 拿**内存里的会话凭据**帮你把请求签名好了——插件只需带 `oc_sid`
  敲本地端口，所以现在的实现简单；
- 想做「不开 App 也签到」，就得把 `Ji()` 那套 V11-HMAC-SHA256 签名逻辑复刻进插件
  （AK/SK 大概率就是 routing_state 那份 Basic 解出来的同一对，还能从
  `provider-profiles.secrets.local.json` 的 `apiKeyRef`（wincred）拿到），
  再管 STS token 刷新。工作量中等，属于明确的下一步，不是做不到。

**要不要用抓包？** 不需要 —— 接口定义直接在 `D:\OfficeAce\packages\api\dist\index.js`
里静态可读（上面就是），`capture/oa_capture.py` 那个 mitmproxy addon 只是补充手段，
适合看动态 token/签名头长什么样，验证我们的复刻对不对。

---

## 逆向记录

OfficeAce 是 Electron 桌面端 + 本地服务，安装目录 `D:\OfficeAce`：

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| Electron 壳 | `OfficeAce.exe` / `resources/app.asar` | 界面 |
| 本地 API | `packages/api/dist/cli.js`（node，`https://127.0.0.1:3004`，自签证书） | 会话、消息、智能体、socket.io |
| 智能体运行时 | `tools/python/Lib/site-packages/jiuwenswarm`（Python 3.13） | 真正调模型、跑工具 |
| 模型网关 | `https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2` | 华为云 ModelArts MaaS |

### 1. 一开始的路是错的

本地 API 的模型是「智能体 + 会话 + 消息」，不是模型 API：

```
POST /api/threads    建会话(可带 preferredModel)
POST /api/messages   发消息, 立刻返回 invocationId
socket.io thread:<id>  agent_message 帧: type=text 逐字增量,
                       type=done+isFinal 收尾, system_info 带 usage
```

这条路能通（早期版本就是这么做的），但代价很重。**实测同一句提问**：

| | prompt_tokens |
| --- | --- |
| 走智能体 | **51928** |
| 直连网关 | **36** |

差了两个数量级 —— 因为智能体每一轮都要塞进「人设 + 技能清单 + 记忆检索」的固定
系统提示。而且这条路**拿不到工具调用**：`/api/messages` 只接受一条纯文本 `content`。

（`/api/maas-send` 曾是一条直连模型的近路，官方已废弃，返回 410。）

### 2. 找到真正的模型调用点

`jiuwenswarm/llm_sse_patch.py` 的模块注释直接写明了机制：

> 3. 保留 `Authorization`：openjiuwen `sanitize_headers` 会剥离 protected
>    `authorization`。OfficeClaw / Huawei MaaS 经 tip `default_headers` 下发的是
>    `Authorization: Basic ...`（`api_key` 仅为占位 `huawei-maas-session`）；
>    若不保留该头，网关会报 APIG.0303。

运行时的模型配置落在
`~/.office-claw/.jiuwenclaw/config/routing_state/users/<uid>/models.json`：

```json
{
  "model_client_config": {
    "api_base": "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2",
    "api_key": "huawei-maas-session",
    "model_name": "deepseek-v4.1-flash",
    "client_provider": "OpenAI",
    "custom_headers": { "Authorization": "Basic <base64(ak:sk)>" }
  }
}
```

也就是说：**真凭据是那个 Basic 头，`api_key` 只是占位符。**

### 3. 直连验证

照抄这份配置直接打网关：

```
POST <api_base>/chat/completions     Authorization: Basic <...>
```

四项全通：

- `/chat/completions` 非流式 → `{"choices":[{"message":{"content":...}}]}`
- `/chat/completions` `stream:true` → 标准 `delta` 分片 + `data: [DONE]`
- `tools` → 原生 `finish_reason: "tool_calls"` + 合法 `arguments` JSON
- `/models` → 21 个模型

结论：网关**原生就是 OpenAI 协议**，OfficeAce 打的那些补丁只是为了绕开自己
SDK 的 header 清洗和某些代理模式下的字段错位。

### 4. 网关的几个坑（都已处理）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `404 ModelArts.81009 Invalid model` | 模型按需拉起，间歇性命中未加载的后端 | 自动重试 4 次（`isColdStart`） |
| 流式内容为空 | token 在 `choices[0].delta.reasoning_content`，`content` 先为空 | `normalizeDelta` 同时认 `delta` / `message` / `token_text` |
| 工具参数不是合法 JSON | GLM 把原生 `<arg_value>` 等 XML 标签漏进了 arguments | `sanitizeToolArgs` 清洗（与官方补丁同规则） |
| 非流式请求却回 SSE | 某些网关模式只回 `text/event-stream` | `assembleFromSse` 把整段拼回 `chat.completion` |

---

## 安装

```bash
magpie plugin add /path/to/magpie-officeAce-auth
magpie plugin login officeace        # 默认 oauth 方法, 本机会话在就秒过
magpie provider test officeace
```

登录框里如果有方法选择，默认选 **oauth**（自动持久化账号名）；想用旧行为就选
`api` 方法。两个方法都支持 `auto` / 手动粘 `oc_sid`。

然后在 magpie 里把某个 agent 的模型设成 `officeace/glm-5.2` 之类。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAGPIE_OFFICEACE_GATEWAY_BASE` | 从 routing_state 读，兜底为上面那个网关 | 网关地址 |
| `MAGPIE_OFFICEACE_GATEWAY_AUTH` | 从 routing_state 读，兜底为本机安装下发的那份 | `Authorization` 头原值 |
| `MAGPIE_OFFICEACE_ROUTING_ROOT` | `~/.office-claw/.jiuwenclaw/config/routing_state/users` | 凭据搜索目录 |
| `MAGPIE_OFFICEACE_RETRY` | `4` | 冷启动/5xx 重试次数 |
| `MAGPIE_OFFICEACE_RETRY_MS` | `1000` | 重试基础间隔（线性退避） |
| `MAGPIE_OFFICEACE_DEBUG` | 空 | 置 `1` 时把请求体打进日志 |
| `MAGPIE_OFFICEACE_AGENT` | `office` | 走智能体链路时的默认智能体 |
| `MAGPIE_OFFICEACE_COOKIE` | 空 | 手动指定 `oc_sid`（仅智能体链路需要） |
| `MAGPIE_OFFICEACE_COOKIE_FILE` | `~/.office-claw/session.cookie` | 登录态文件 |
| `MAGPIE_OFFICEACE_TIMEOUT_MS` | `300000` | 智能体链路单轮超时 |
| `MAGPIE_OFFICEACE_POLL_MS` | `500` | 智能体链路降级轮询间隔 |

### 凭据是怎么来的

按顺序找，第一个命中就用：

1. 环境变量 `MAGPIE_OFFICEACE_GATEWAY_AUTH`
2. `routing_state/users/*/models.json` 里 `custom_headers.Authorization`
   （**推荐**，OfficeAce 轮换凭据时会自动跟上）
3. 本机安装下发的那份常量（`lib/gateway.mjs` 的 `BAKED_AUTH`）

智能体链路另外需要 `oc_sid` 登录态：`~/.office-claw/session.cookie`，
`OC-DPAPI-1` 开头，DPAPI 密文解出来是 `{value, expires}`，用 PowerShell 解。

---

## 自测

```bash
bun test.mjs              # 单元 + 直连链路 + 档位
bun test.mjs --agent      # 额外跑一次智能体兜底(慢, 且吃 5 万 token)
bun tools/test-standalone.mjs         # 隔离态: 证明不开 OfficeAce 也能用
bun tools/probe-gateway.mjs [模型]    # 不带插件, 裸打网关看原始回包
bun tools/probe-maas-models.mjs       # 看 OfficeAce 自己启用了哪些模型
bun tools/diag-agent.mjs [模型]       # 查 preferredModel 是否真落到会话上
```

## 限制

- 直连是**无状态**的：多轮要由调用方自己带完整 `messages`，插件不做会话复用
  （这本来就是 chat completions 的语义）。
- 凭据来自本机 OfficeAce 安装。换机器要先登录一次 OfficeAce。
- 智能体链路：一次只吃一条 `content`，多轮会被压成带标记的文本；不支持工具调用；
  每请求新建会话（约 0.3s 固定开销）；`tool_call` 声明为 `false`。
- 网关冷启动抖动是上游行为，重试能盖住大部分，但首次命中一个长期未用的模型仍可能慢。
- 改了插件代码要 `magpie plugin off` + `on` 才会重载，跑着的宿主不热更。
