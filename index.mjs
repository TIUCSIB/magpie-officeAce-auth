// magpie 插件: OfficeAce -> OpenAI 兼容接口
//
// 两条链路, 按模型名选:
//
//   officeace/<模型>        直连网关 (主力, 推荐)
//                           https://modelgw-0009.officeace.../v2 —— 原生 OpenAI 协议,
//                           真 SSE、原生 tool_calls、reasoning_content。
//                           实测 prompt_tokens≈36(只有你真正发的内容)。
//
//   officeace/agent         走 OfficeAce 的智能体 (兜底)
//   officeace/agent:<id>    可指定智能体, 例如 officeace/agent:assistant
//                           等价于在桌面端界面里对话。会带上智能体的固定系统提示,
//                           实测 prompt_tokens≈51928, 且不支持工具调用。
//
// 逆向依据见 README「逆向记录」小节。
import { discoverSession } from "./lib/cookie.mjs";
import {
  discoverGateway,
  bareModel,
  gatewayHeaders,
  gatewayUrl,
  translateStream,
  assembleFromSse,
  sseResponse,
} from "./lib/gateway.mjs";
import {
  messagesToPrompt,
  parseUsage,
  runTurn,
  makeClient,
  DEFAULT_AGENT,
} from "./lib/agent.mjs";
import { readSubscription, claimBonus, OFFLINE_HINT } from "./lib/subscription.mjs";

const PROVIDER = "officeace";
const CLIENT_BASE = `https://officeace.local/v1`; // 占位; 真实请求由 loader 的 fetch 接管

// magpie 不落库 authorize() 的 accountId(api 类方法), 插件自己写一次就够
let accountPersisted = false;

// ── 模型能力表 ─────────────────────────────────────────────────────────
// 依据 OfficeAce 自带模型目录里的 labels / capabilities
// (packages/api/dist/index.js 的模型元数据: "Function Call" / "198K" / "1M" 等)
const CAPS = {
  "glm-5.3":         { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.3-flash":   { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.3-test":    { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.3-zx":      { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.2":         { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.2-zx":      { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.2-a3":      { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.2-harmony": { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm-5.1":         { context: 202752,  output: 131072, tool: true, reasoning: true },
  "glm.5.2-arkts-spark": { context: 202752, output: 131072, tool: true, reasoning: true },
  "deepseek-v4.1-flash":       { context: 1000000, output: 32768, tool: true, reasoning: true, image: true },
  "deepseek-v4.1-flash-0930":  { context: 1000000, output: 32768, tool: true, reasoning: true, image: true },
  "deepseek-v4-flash":         { context: 1000000, output: 32768, tool: true, reasoning: true },
  "deepseek-v4-flash-0731":    { context: 1000000, output: 32768, tool: true, reasoning: true },
  "deepseek-v4-pro":           { context: 1000000, output: 65536, tool: true, reasoning: true },
  "kimi-k2.6":       { context: 262144,  output: 32768, tool: true, reasoning: false },
  "kimi-k3-test-1009": { context: 262144, output: 32768, tool: true, reasoning: false },
  "qwen3-32b":       { context: 131072,  output: 32768, tool: true, reasoning: true },
  "qwen3-30b-a3b":   { context: 131072,  output: 32768, tool: true, reasoning: true },
  "openpangu-2.0-pro":   { context: 131072, output: 32768, tool: true, reasoning: true },
  "openpangu-2.0-flash": { context: 131072, output: 32768, tool: true, reasoning: true },
};
const DEFAULT_CAPS = { context: 131072, output: 32768, tool: true, reasoning: true };

const AGENT_MODEL = {
  name: "OfficeAce 智能体 (带固定系统提示, 无工具调用)",
  limit: { context: 160000, output: 32000 },
  tool_call: false,
  reasoning: false,
  modalities: { input: ["text"], output: ["text"] },
};

// 网关实测接受的档位 (传别的值会 400, 报错里就带着这个枚举)
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** magpie 的档位 -> 请求体里的 reasoning_effort */
const VARIANTS = Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }]));

function capsOf(id) {
  const c = CAPS[id] ?? DEFAULT_CAPS;
  return {
    limit: { context: c.context, output: c.output },
    tool_call: c.tool !== false,
    reasoning: c.reasoning === true,
    // 只有会思考的模型才给档位选择; 不给的话 magpie 不会往请求体放 reasoning_effort
    ...(c.reasoning === true ? { variants: VARIANTS } : {}),
    modalities: c.image
      ? { input: ["text", "image"], output: ["text"] }
      : { input: ["text"], output: ["text"] },
  };
}

// OfficeAce 界面上启用的那几个。取不到实时清单时用它兜底,
// 保证「关掉 OfficeAce 也能用」这个性质不被破坏。
const OFFICE_FALLBACK = ["glm-5.2", "glm-5.1", "deepseek-v4-flash-0731", "deepseek-v4.1-flash"];

/** MAGPIE_OFFICEACE_MODELS: office(默认) | all | 逗号分隔的显式清单 */
function modelMode() {
  return (process.env.MAGPIE_OFFICEACE_MODELS || "office").trim();
}

let officeModelsCache = { at: 0, ids: null };

/** 问 OfficeAce 要它「启用」的模型清单; 问不到就回兜底。 */
async function officeEnabledModels(cookie) {
  if (officeModelsCache.ids && Date.now() - officeModelsCache.at < 60000) {
    return officeModelsCache.ids;
  }
  if (cookie) {
    try {
      const list = await makeClient(cookie).listModels();
      const ids = list.map((m) => m.model).filter(Boolean);
      if (ids.length) {
        officeModelsCache = { at: Date.now(), ids };
        return ids;
      }
    } catch {
      // App 没开 / 登录态失效 —— 用兜底, 直连照样能用
    }
  }
  return OFFICE_FALLBACK;
}

/**
 * 模型名 -> 走哪条链路
 *   <模型>                     直连网关
 *   agent                      智能体(本机默认, 通常是 office)
 *   agent:<agentId>            指定智能体
 *   agent:<agentId>@<模型>     指定智能体 + 指定后端模型
 */
export function routeOf(model) {
  const bare = bareModel(model);
  if (bare === "agent" || bare.startsWith("agent:") || bare.startsWith("agent@")) {
    const rest = bare.slice("agent".length);
    const at = rest.indexOf("@");
    const idPart = at >= 0 ? rest.slice(0, at) : rest;
    return {
      kind: "agent",
      agentId: idPart.replace(/^[:@]/, "").trim() || DEFAULT_AGENT,
      preferredModel: at >= 0 ? rest.slice(at + 1).trim() || null : null,
    };
  }
  return { kind: "gateway", model: bare };
}

// ── 响应构造 ───────────────────────────────────────────────────────────

function jsonError(status, message, type = "officeace_error") {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completionResponse({ id, model, text, reasoning, toolCalls, usage }) {
  const message = { role: "assistant", content: text || (toolCalls?.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls?.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseChunk({ id, model, delta, finish = null }) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

// ── 直连网关 ───────────────────────────────────────────────────────────

/**
 * 不思考的模型不认识 reasoning_effort; 客户端硬塞会 400。
 * 我们不替它猜, 直接摘掉。
 */
function stripUnsupportedEffort(body, model) {
  if (body?.reasoning_effort === undefined) return body;
  if (capsOf(model).reasoning) return body;
  const { reasoning_effort, ...rest } = body;
  return rest;
}

const RETRY = Number(process.env.MAGPIE_OFFICEACE_RETRY ?? 4);
const RETRY_MS = Number(process.env.MAGPIE_OFFICEACE_RETRY_MS ?? 1000);

/**
 * 华为 MaaS 的模型是按需拉起的: 某个模型一段时间没被调用, 首次命中会返回
 * 404 ModelArts.81009 "Invalid model"(实测), 稍后就正常。这类以及 429/5xx
 * 都值得重试一次。
 */
function isColdStart(status, text) {
  if (status === 429 || status >= 500) return true;
  return status === 404 && /ModelArts\.81009|Invalid model/i.test(text);
}

async function callGateway({ gw, model, body, wantStream, init }) {
  const upstream = { ...body, model };
  delete upstream.stream_options;
  const payload = JSON.stringify(upstream);
  const url = gatewayUrl(gw, "/chat/completions");

  let res;
  let lastText = "";
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: gatewayHeaders(gw),
      body: payload,
      signal: init.signal,
    });
    if (res.ok) break;
    lastText = await res.text().catch(() => "");
    if (attempt >= RETRY || !isColdStart(res.status, lastText)) {
      throw Object.assign(new Error(`网关返回 HTTP ${res.status}: ${lastText.slice(0, 400)}`), {
        status: res.status,
      });
    }
    await new Promise((r) => setTimeout(r, RETRY_MS * (attempt + 1)));
  }

  const ctype = res.headers.get("content-type") ?? "";

  // 非流式请求, 但网关仍吐 SSE —— OfficeAce 自己也遇到并打了补丁
  if (!wantStream && ctype.includes("text/event-stream")) {
    const assembled = assembleFromSse(await res.text());
    assembled.model = model;
    return new Response(JSON.stringify(assembled), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (wantStream) {
    if (!ctype.includes("text/event-stream")) {
      // 网关不认 stream, 退回单块流
      const json = await res.json().catch(() => null);
      const text = json?.choices?.[0]?.message?.content ?? "";
      const reasoning = json?.choices?.[0]?.message?.reasoning_content ?? "";
      const id = json?.id ?? `chatcmpl-${Date.now().toString(36)}`;
      const stream = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(sseChunk({ id, model, delta: { role: "assistant" } })));
          if (reasoning) c.enqueue(enc.encode(sseChunk({ id, model, delta: { reasoning_content: reasoning } })));
          if (text) c.enqueue(enc.encode(sseChunk({ id, model, delta: { content: text } })));
          c.enqueue(enc.encode(sseChunk({ id, model, delta: {}, finish: "stop" })));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return sseResponse(stream);
    }
    return sseResponse(translateStream(res.body, model));
  }

  const json = await res.json().catch(() => null);
  if (!json) throw new Error("网关返回了无法解析的响应");
  if (json.model === undefined) json.model = model;
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ── 智能体兜底 ─────────────────────────────────────────────────────────

async function callAgent({ client, route, body, wantStream, init, log }) {
  const requestModel = body.model;
  const { agentId, preferredModel } = route;

  const prompt = messagesToPrompt(body.messages);
  const id = `chatcmpl-${Date.now().toString(36)}`;

  let text = "";
  let usage = null;

  if (!wantStream) {
    await runTurn({
      client,
      agentId,
      preferredModel,
      prompt,
      onDelta: (d) => (text += d),
      onUsage: (u) => (usage = u),
      signal: init.signal,
      log,
    });
    return new Response(
      JSON.stringify(completionResponse({ id, model: requestModel, text, usage })),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s));
      push(sseChunk({ id, model: requestModel, delta: { role: "assistant" } }));
      try {
        await runTurn({
          client,
          agentId,
          preferredModel,
          prompt,
          onDelta: (d) => {
            text += d;
            push(sseChunk({ id, model: requestModel, delta: { content: d } }));
          },
          onUsage: (u) => (usage = u),
          signal: init.signal,
          log,
        });
        push(sseChunk({ id, model: requestModel, delta: {}, finish: "stop" }));
        push("data: [DONE]\n\n");
      } catch (err) {
        push(
          `data: ${JSON.stringify({
            error: { message: err?.message ?? String(err), type: "officeace_error" },
          })}\n\n`,
        );
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}

// ── 插件本体 ───────────────────────────────────────────────────────────

export const OfficeAcePlugin = async ({ client } = {}) => {
  const log = {
    info: (m) => client?.app?.log?.({ body: { service: "officeace", level: "info", message: m } }),
    warn: (m) => client?.app?.log?.({ body: { service: "officeace", level: "warn", message: m } }),
  };

  const resolveCookie = (auth) => {
    const key = auth?.key?.trim();
    return key && key !== "auto" ? key : discoverSession().cookie;
  };

  const agentModels = () => ({
    agent: { ...AGENT_MODEL, id: "agent", name: "OfficeAce 智能体" },
  });

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      // 这里的 models 只是占位; 真正那份由下面的 provider.models 给
      const seed = {};
      for (const id of OFFICE_FALLBACK) seed[id] = { ...capsOf(id), id, name: id };
      cfg.provider[PROVIDER] ??= {
        name: "OfficeAce",
        npm: "@ai-sdk/openai-compatible",
        api: CLIENT_BASE,
        models: { ...seed, ...agentModels() },
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "OfficeAce 本机登录态",
          placeholder: "留空 = 自动读取 ~/.office-claw/session.cookie",
          async authorize(inputs) {
            const given = String(inputs?.key ?? "").trim();

            // 直连链路只依赖磁盘上的网关凭据, 不需要 OfficeAce 正在运行;
            // 登录态(oc_sid)只有智能体兜底链路和积分/签到用得上, 拿不到就降级。
            const gw = discoverGateway();
            let cookie = "";
            let cookieNote = "";
            if (given) {
              cookie = given;
            } else {
              try {
                cookie = discoverSession().cookie;
              } catch (err) {
                cookieNote = err?.message ?? String(err);
              }
            }

            if (!gw.authorization && !cookie) {
              return {
                type: "failed",
                error: `既找不到网关凭据也找不到登录态: ${cookieNote}`,
              };
            }

            // 向本地 API 问一下账号名, 让 magpie 显示 "某某" 而不是 cookie 末四位。
            // 手动粘贴的 cookie 也走这条, 不然那一路永远只有 "API key"。
            // App 没开也继续(直连不需要它), 只是 accountId 留空。
            let accountId = "";
            let session = cookie ? "ok" : `unavailable: ${cookieNote}`;
            let needsReauth = false;
            if (cookie) {
              try {
                const info = await makeClient(cookie).isLogin();
                const d = info.data;
                if (d?.islogin) {
                  accountId = String(d.userName ?? "").trim();
                  needsReauth = d.needsReauth === true;
                  if (needsReauth) session = "needs-reauth";
                } else if (d) {
                  session = "not-logged-in";
                }
              } catch {
                session = "local-api-unreachable";
              }
            }

            return {
              type: "success",
              key: cookie || "auto",
              ...(accountId ? { accountId } : {}),
              metadata: {
                gateway: gw.base,
                gatewayAuth: gw.source,
                session,
                ...(needsReauth ? { needsReauth: true } : {}),
              },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        let cookie = "";
        try {
          cookie = resolveCookie(auth);
        } catch (err) {
          log.warn(`读取 OfficeAce 登录态失败(仅智能体链路需要): ${err?.message ?? err}`);
        }
        const gw = discoverGateway();
        // 注意别叫 client: 外层那个是 magpie 的运行期 client, 有 .auth.set
        const oa = makeClient(cookie);

        log.info(`网关直连: ${gw.base} (凭据来源 ${gw.source})`);

        // magpie 不会把 authorize() 返回的 accountId 落库(api 类方法),
        // 得插件自己写一次; 只试一次, 免得每个请求都写盘。
        if (!accountPersisted && client?.auth?.set && cookie) {
          accountPersisted = true;
          try {
            const info = await oa.isLogin();
            const name = info.data?.islogin ? String(info.data.userName ?? "").trim() : "";
            if (name && name !== String(auth?.accountId ?? "")) {
              await client.auth.set({
                path: { id: PROVIDER },
                body: { ...auth, accountId: name },
              });
              log.info(`账号名已记录: ${name}`);
            }
          } catch {}
        }

        return {
          baseURL: CLIENT_BASE,
          apiKey: "officeace-local",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : (input?.url ?? String(input));
            let body = {};
            try {
              body = init.body ? JSON.parse(String(init.body)) : {};
            } catch {
              body = {};
            }

            // /models: 需要登录态的走 OfficeAce, 否则回网关
            if (/\/models\b/.test(url) && !init.method) {
              try {
                const r = await fetch(gatewayUrl(gw, "/models"), { headers: gatewayHeaders(gw) });
                if (r.ok) return r;
              } catch {}
            }

            const route = routeOf(body.model);
            const wantStream = body.stream === true;
            const target = route.kind === "gateway" ? route.model : route.agentId;
            log.info(
              `model=${JSON.stringify(body.model)} -> ${route.kind}:${target}`
              + ` stream=${wantStream} tools=${Array.isArray(body.tools) ? body.tools.length : 0}`,
            );
            if (process.env.MAGPIE_OFFICEACE_DEBUG) {
              const { messages, ...rest } = body;
              log.info(`body=${JSON.stringify(rest).slice(0, 600)} msgs=${messages?.length ?? 0}`);
            }

            try {
              if (route.kind === "agent") {
                return await callAgent({
                  client: oa,
                  route,
                  body,
                  wantStream,
                  init,
                  log,
                });
              }
              return await callGateway({
                gw,
                model: route.model ?? bareModel(body.model),
                body: stripUnsupportedEffort(body, route.model ?? bareModel(body.model)),
                wantStream,
                init,
              });
            } catch (err) {
              const msg = err?.message ?? String(err);
              log.warn(`[${url}] ${msg}`);
              const status = err?.status ?? (/401|403|登录|Authentication/.test(msg) ? 401 : 502);
              return jsonError(status, msg);
            }
          },
        };
      },
    },

    /**
     * 积分余额 -> magpie 的 Usage 卡片。
     * 契约: { balance?, windows: [{name, used(0-100), display, aside}], error? }
     */
    async usage(getAuth) {
      const auth = await getAuth().catch(() => null);
      if (!auth) return { error: "未登录", windows: [] };
      let cookie;
      try {
        cookie = resolveCookie(auth);
      } catch (err) {
        return { error: err?.message ?? String(err), windows: [] };
      }

      // 先看签到状态(只读), 不在这里补签 —— 补签交给 magpie 的 Daily check-in
      let sub;
      try {
        sub = await readSubscription(makeClient(cookie));
      } catch (err) {
        return { error: `${OFFLINE_HINT}: ${err?.message ?? err}`, windows: [] };
      }
      if (!sub.ok) return { error: sub.error, windows: [] };

      const money = (n) => (Number.isFinite(n) ? Math.round(n) : 0);
      // 窗口条吃的是「已用」百分比, magpie 画出来是剩余
      const usedPct = sub.unlimited ? 0 : Math.max(0, Math.min(100, 100 - sub.percent));

      const windows = [
        {
          name: "积分余额",
          used: usedPct,
          display: sub.unlimited ? "不限量" : `${money(sub.remaining)} / ${money(sub.total)} 积分`,
          aside: true,
        },
      ];

      if (sub.daily) {
        windows.push({
          name: "每日签到",
          used: 0,
          display: sub.daily.claimedToday
            ? `今日已签 ✓ +${sub.daily.points}`
            : `今日未签（+${sub.daily.points}）`,
          aside: true,
        });
      }

      for (const b of sub.bonuses) {
        if (!b.name || /checkin|daily/i.test(b.id)) continue;
        windows.push({ name: b.name, used: 0, display: `+${b.points} 积分`, aside: true });
      }

      if (sub.plan) {
        const until = sub.expiresAt ? ` · 至 ${String(sub.expiresAt).slice(0, 10)}` : "";
        windows.push({ name: "套餐", used: 0, display: `${sub.plan}${until}`, aside: true });
      }

      if (sub.account?.loggedOut) {
        windows.push({ name: "登录态", used: 0, display: "未登录，请打开 OfficeAce 登录", aside: true });
      } else if (sub.account?.needsReauth) {
        windows.push({ name: "登录态", used: 0, display: "已失效，请重新登录 OfficeAce", aside: true });
      }

      return {
        balance: sub.unlimited ? "不限量" : `${money(sub.remaining)} 积分`,
        windows,
      };
    },

    /**
     * 每日签到 -> POST /api/subscription/claim-bonus
     * 契约: { outcome, credit?, streak?, message? }; throw 则 magpie 30 分钟后重试。
     * 由 magpie 「Settings → Usage → Plugins → Daily check-in」开关调度。
     */
    async checkin(getAuth) {
      const auth = await getAuth().catch(() => null);
      if (!auth) throw new Error("未登录");
      const cookie = resolveCookie(auth);

      let r;
      try {
        r = await claimBonus(makeClient(cookie));
      } catch (err) {
        // 连不上本地 API: 抛出去让 magpie 稍后重试, 别当成「已签到」
        throw new Error(`${OFFLINE_HINT}: ${err?.message ?? err}`);
      }
      if (!r.ok) throw new Error(r.error);

      // 服务端幂等: 今天领过了就回空数组, 那不是失败
      if (!r.points) return { outcome: "done", message: "今日已签到" };
      return {
        outcome: "done",
        credit: r.points,
        message: `签到 +${r.points} 积分`,
      };
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const mode = modelMode();
        let cookie = "";
        try {
          cookie = resolveCookie(auth);
        } catch {}

        // 显式清单: 只暴露列出来的
        if (mode !== "office" && mode !== "all") {
          const ids = mode.split(",").map((s) => s.trim()).filter(Boolean);
          const out = {};
          for (const id of ids) out[id] = { ...capsOf(id), id, name: id };
          return { ...out, ...agentModels() };
        }

        let ids;
        try {
          const gw = discoverGateway();
          const r = await fetch(gatewayUrl(gw, "/models"), { headers: gatewayHeaders(gw) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const all = ((await r.json())?.data ?? []).map((m) => m?.id ?? m?.model).filter(Boolean);
          if (!all.length) throw new Error("空清单");
          // 默认只给 OfficeAce 界面里启用的那几个(用户看到的就是这些),
          // 想看网关全量就设 MAGPIE_OFFICEACE_MODELS=all
          if (mode === "all") {
            ids = all;
          } else {
            const enabled = new Set(await officeEnabledModels(cookie));
            ids = all.filter((id) => enabled.has(id));
            if (!ids.length) ids = OFFICE_FALLBACK;
          }
        } catch (err) {
          log.warn(`拉取网关模型清单失败, 用兜底: ${err?.message ?? err}`);
          ids = OFFICE_FALLBACK;
        }

        const out = {};
        for (const id of ids) out[id] = { ...capsOf(id), id, name: id };
        return { ...out, ...agentModels() };
      },
    },
  };
};

export default { id: "magpie-officeace-auth", server: OfficeAcePlugin };

export const _internal = {
  messagesToPrompt,
  parseUsage,
  routeOf,
  bareModel,
  capsOf,
  stripUnsupportedEffort,
  EFFORTS,
  VARIANTS,
  completionResponse,
  sseChunk,
  assembleFromSse,
};
