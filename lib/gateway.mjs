// OfficeAce 背后的模型网关 —— 原生 OpenAI 兼容直连
//
// 逆向结论(证据见 README「逆向记录」):
//   OfficeAce 桌面端自己并不跑模型。它的智能体运行时(jiuwenswarm / openjiuwen,
//   Python)通过 OpenAI SDK 调用华为云 ModelArts MaaS 网关:
//
//     api_base = https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2
//     api_key  = "huawei-maas-session"           <-- 占位符, 不是真凭据
//     真凭据    = custom_headers.Authorization: Basic <base64(ak:sk)>
//
//   该网关是标准 OpenAI 协议: /chat/completions(含 stream)、/models、
//   原生 tool_calls。OfficeAce 之所以要打补丁(见 jiuwenswarm/llm_sse_patch.py),
//   只是因为 openjiuwen 的 sanitize_headers 会剥掉 Authorization 头,
//   以及某些代理模式下内容放在 message.token_text / reasoning_token_text。
//
// 直连的意义: 绕开智能体那一层「人设 + 技能 + 记忆检索」的固定提示词。
//   实测同一句提问, 智能体链路 prompt_tokens≈51928, 直连≈36。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE =
  process.env.MAGPIE_OFFICEACE_GATEWAY_BASE
  || "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2";

/**
 * 本机私有兜底凭据。**刻意不进仓库**(见 .gitignore):
 * 那份 Basic 凭据等价于一对 AK/SK, 公开出去会被滥用/吊销,
 * 反过来把所有人这个插件一起搞坏。
 *
 * 想留一份本机兜底, 就建 lib/gateway-auth.local.json:
 *   { "base": "https://<网关>/v2", "authorization": "Basic <base64(ak:sk)>" }
 */
function localAuthFile() {
  return process.env.MAGPIE_OFFICEACE_AUTH_FILE
    || join(dirname(fileURLToPath(import.meta.url)), "gateway-auth.local.json");
}

function readLocalAuth() {
  const f = localAuthFile();
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const authorization = typeof j?.authorization === "string" ? j.authorization.trim() : "";
    if (!authorization) return null;
    return { base: typeof j?.base === "string" ? j.base.trim() : "", authorization };
  } catch {
    return null;
  }
}

/** OfficeAce 把模型路由状态按用户分目录落盘, 里面带着网关凭据。 */
function routingUsersRoot() {
  return (
    process.env.MAGPIE_OFFICEACE_ROUTING_ROOT
    || join(homedir(), ".office-claw", ".jiuwenclaw", "config", "routing_state", "users")
  );
}

function authFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === "authorization" && typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

/**
 * 从 OfficeAce 自己的路由状态里读网关凭据。
 * 返回 { base, authorization, modelNames:Set, source }
 */
export function discoverGateway() {
  const envBase = process.env.MAGPIE_OFFICEACE_GATEWAY_BASE?.trim();
  const envAuth = process.env.MAGPIE_OFFICEACE_GATEWAY_AUTH?.trim();

  const root = routingUsersRoot();
  if (existsSync(root)) {
    let users = [];
    try {
      users = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      users = [];
    }
    for (const u of users) {
      const file = join(root, u.name, "models.json");
      if (!existsSync(file)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const entries = Array.isArray(parsed?.defaults) ? parsed.defaults : [];
      for (const e of entries) {
        const mcc = e?.model_client_config;
        if (!mcc) continue;
        const auth = authFromHeaders(mcc.custom_headers);
        if (!auth) continue;
        return {
          base: (envBase || mcc.api_base || DEFAULT_BASE).replace(/\/+$/, ""),
          authorization: envAuth || auth,
          modelNames: new Set(entries.map((x) => x?.model_client_config?.model_name).filter(Boolean)),
          source: `routing_state:${u.name}`,
        };
      }
    }
  }

  if (envAuth) {
    return { base: (envBase || DEFAULT_BASE).replace(/\/+$/, ""), authorization: envAuth, modelNames: new Set(), source: "env" };
  }
  const local = readLocalAuth();
  if (local) {
    return {
      base: (envBase || local.base || DEFAULT_BASE).replace(/\/+$/, ""),
      authorization: local.authorization,
      modelNames: new Set(),
      source: `local-file:${localAuthFile()}`,
    };
  }
  // 什么都没找到: 不猜, 交给上层给出可执行的指引
  return {
    base: (envBase || DEFAULT_BASE).replace(/\/+$/, ""),
    authorization: null,
    modelNames: new Set(),
    source: "none",
  };
}

/** 没凭据时该怎么说 */
export const NO_AUTH_HINT =
  "找不到网关凭据。三种办法任选: "
  + "1) 先启动一次 OfficeAce(它会把凭据写到 ~/.office-claw/.jiuwenclaw/config/routing_state/); "
  + "2) 设 MAGPIE_OFFICEACE_GATEWAY_AUTH=\"Basic <base64(ak:sk)>\"; "
  + `3) 建 ${localAuthFile()} 写 {"authorization":"Basic ..."}。`;

// ── 模型名归一化 ────────────────────────────────────────────────────────

/** 去掉 provider 前缀: "officeace/glm-5.2" -> "glm-5.2" */
export function bareModel(model) {
  const raw = String(model ?? "").trim();
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
}

// ── 推理/内容字段归一化 ─────────────────────────────────────────────────
//
// 标准网关: delta.content / delta.reasoning_content
// 代理模式: message.token_text / message.reasoning_token_text
function pickString(src, ...keys) {
  for (const k of keys) {
    const v = src?.[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function normalizeDelta(obj) {
  const choice = obj?.choices?.[0] ?? {};
  // 网关流式: choices[0].delta.*
  // 网关非流式: choices[0].message.*
  // 某些代理模式: choices[0].message.token_text / reasoning_token_text
  const src = choice.delta ?? choice.message ?? obj?.delta ?? obj?.message ?? {};
  return {
    content: pickString(src, "content", "token_text"),
    reasoning: pickString(src, "reasoning_content", "reasoning_token_text"),
    msg: src,
  };
}

// GLM 在工具参数里漏出原生 XML 标签时会污染下游 JSON.parse —— 与
// OfficeAce 的 llm_sse_patch 做同样的清洗。
const GLM_CLOSED = /<(arg_value|arg_key|tool_call)[^>]*?>[\s\S]*?<\/\1>/gi;
const GLM_OPEN = /^[\s\S]*?<(?:arg_value|arg_key|tool_call)[^>]*?>/i;

export function sanitizeToolArgs(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  const lowered = raw.toLowerCase();
  if (!lowered.includes("<arg_") && !lowered.includes("<tool_call")) return raw;
  let out = raw.replace(GLM_CLOSED, "");
  let prev;
  do {
    prev = out;
    out = out.replace(GLM_OPEN, "");
  } while (prev !== out);
  return out;
}

// ── SSE 解析 ────────────────────────────────────────────────────────────

/** 把 SSE 文本流切成 data: 负载(处理跨网络分片的半行)。 */
function sseDataEvents() {
  let buf = "";
  return {
    push(text) {
      buf += text;
      const out = [];
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        out.push(line.slice(5).trim());
      }
      return out;
    },
    flush() {
      const rest = buf.trim();
      buf = "";
      return rest.startsWith("data:") ? [rest.slice(5).trim()] : [];
    },
  };
}

/** 非流式请求却收到 text/event-stream 时, 把整段 SSE 拼成一个 completion。 */
export function assembleFromSse(text) {
  const events = sseDataEvents();
  const lines = events.push(text.endsWith("\n") ? text : text + "\n");
  for (const l of events.flush()) lines.push(l);

  let content = "";
  let reasoning = "";
  let last = null;
  const toolCalls = [];

  for (const payload of lines) {
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    last = obj;
    const { content: c, reasoning: r, msg } = normalizeDelta(obj);
    content += c;
    reasoning += r;
    for (const tc of msg?.tool_calls ?? []) {
      toolCalls.push({
        id: tc.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: tc?.function?.name ?? "",
          arguments: sanitizeToolArgs(tc?.function?.arguments ?? "{}"),
        },
      });
    }
  }

  const message = { role: "assistant", content: content || (toolCalls.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: last?.id ?? `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: last?.created ?? Math.floor(Date.now() / 1000),
    model: last?.model ?? "unknown",
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: last?.usage ?? undefined,
  };
}

// ── 请求 ────────────────────────────────────────────────────────────────

/** 构造发往网关的请求头。凭据走 Authorization: Basic, 不是 Bearer。 */
export function gatewayHeaders(gw, extra = {}) {
  if (!gw?.authorization) {
    throw Object.assign(new Error(NO_AUTH_HINT), { status: 401 });
  }
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: gw.authorization,
    // 华为 MaaS 侧链路追踪; OfficeAce 自己也注入
    "x-span-id": crypto.randomUUID().replace(/-/g, ""),
    ...extra,
  };
  return h;
}

export function gatewayUrl(gw, path) {
  return `${gw.base}${path.startsWith("/") ? path : `/${path}`}`;
}

// ── 流式转发 ────────────────────────────────────────────────────────────

/**
 * 把网关的 SSE 原样转成上游(ai-sdk / OpenAI 客户端)能吃的 SSE。
 * 保留 tool_calls 增量、把 reasoning 放到 delta.reasoning_content。
 */
export function translateStream(upstreamBody, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = sseDataEvents();
  const reader = upstreamBody.getReader();

  let id = `chatcmpl-${Date.now().toString(36)}`;
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;

  const chunk = (delta, finish = null, usage = undefined) => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) payload.usage = usage;
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  };

  return new ReadableStream({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const payloads = parser.push(decoder.decode(value, { stream: true }));
          for (const p of payloads) {
            if (!p) continue;
            if (p === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            let obj;
            try {
              obj = JSON.parse(p);
            } catch {
              continue;
            }
            if (obj?.id) id = obj.id;
            if (obj?.created) created = obj.created;

            const choice = obj?.choices?.[0];
            const { content, reasoning, msg } = normalizeDelta(obj);

            const delta = {};
            if (!sentRole) {
              delta.role = "assistant";
              sentRole = true;
            }
            if (reasoning) delta.reasoning_content = reasoning;
            if (content) delta.content = content;

            const rawToolCalls = msg?.tool_calls;
            if (Array.isArray(rawToolCalls) && rawToolCalls.length) {
              delta.tool_calls = rawToolCalls.map((tc, i) => ({
                index: tc?.index ?? i,
                ...(tc?.id ? { id: tc.id } : {}),
                type: "function",
                function: {
                  ...(tc?.function?.name ? { name: tc.function.name } : {}),
                  arguments: sanitizeToolArgs(tc?.function?.arguments ?? ""),
                },
              }));
            }

            const finish = choice?.finish_reason ?? obj?.finish_reason ?? null;
            const hasPayload = Boolean(reasoning || content || (Array.isArray(rawToolCalls) && rawToolCalls.length));
            if (hasPayload || finish) {
              controller.enqueue(chunk(delta, finish, obj?.usage));
            } else if (obj?.usage) {
              controller.enqueue(chunk({}, null, obj.usage));
            }
          }
        }
        for (const p of parser.flush()) {
          if (p === "[DONE]") break;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: { message: err?.message ?? String(err), type: "officeace_gateway_error" } })}\n\n`),
        );
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

export function sseResponse(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...extra,
    },
  });
}
