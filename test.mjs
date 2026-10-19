// 自测: 直接跑插件 hook, 不经过 magpie
//   bun test.mjs                    单元 + 直连链路
//   bun test.mjs --agent            额外跑一次智能体兜底链路(慢, 且吃 5 万 token)
//   bun test.mjs --prompt "..."     换提示词
import { OfficeAcePlugin, _internal } from "./index.mjs";
import { discoverGateway } from "./lib/gateway.mjs";

const args = process.argv.slice(2);
const withAgent = args.includes("--agent");
const prompt = args.find((a, i) => !a.startsWith("--") && args[i - 1] === "--prompt")
  || "用一句话解释什么是 TCP 三次握手";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

console.log("== 单元 ==");
check("routeOf 直连", _internal.routeOf("officeace/glm-5.2").model === "glm-5.2");
check("routeOf 无前缀", _internal.routeOf("glm-5.2").model === "glm-5.2");
check("routeOf 智能体", _internal.routeOf("officeace/agent").kind === "agent");
check("routeOf 指定智能体", _internal.routeOf("officeace/agent:assistant").agentId === "assistant");
check(
  "messagesToPrompt 单轮",
  _internal.messagesToPrompt([{ role: "user", content: "hi" }]) === "hi",
);
check(
  "messagesToPrompt 带 system",
  _internal.messagesToPrompt([
    { role: "system", content: "简洁" },
    { role: "user", content: "hi" },
  ]).includes("简洁"),
);
check(
  "capsOf 工具/推理",
  _internal.capsOf("glm-5.2").tool_call === true && _internal.capsOf("glm-5.2").reasoning === true,
);
check("capsOf 未知模型兜底", _internal.capsOf("nope-1").tool_call === true);

console.log("\n== 凭据发现 ==");
const gw = discoverGateway();
console.log(`  base = ${gw.base}`);
console.log(`  auth = ${gw.authorization.slice(0, 24)}…  (来源 ${gw.source})`);
check("凭据是 Basic", gw.authorization.startsWith("Basic "));

console.log("\n== 插件 hooks ==");
const hooks = await OfficeAcePlugin({
  client: { app: { log: (x) => console.log("   [log]", x.body.message) } },
});
const authz = await hooks.auth.methods[0].authorize({});
check("authorize 成功", authz.type === "success", authz.error ?? "");
const loaded = await hooks.auth.loader(async () => ({ type: "api", key: authz.key }));

const call = (body) =>
  loaded.fetch("https://officeace.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer officeace-local" },
    body: JSON.stringify(body),
  });

console.log("\n== 直连: 非流式 ==");
{
  const t0 = Date.now();
  const res = await call({
    model: "officeace/glm-5.2",
    stream: false,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const j = await res.json();
  const msg = j.choices?.[0]?.message ?? {};
  console.log(`  status=${res.status} ${Date.now() - t0}ms  usage=${JSON.stringify(j.usage)}`);
  console.log(`  content: ${String(msg.content ?? "").slice(0, 160)}`);
  check("有内容", typeof msg.content === "string" && msg.content.length > 0);
  check("prompt_tokens 很小(绕过了 5 万脚手架)", (j.usage?.prompt_tokens ?? 1e9) < 2000, JSON.stringify(j.usage));
}

console.log("\n== 直连: 流式 ==");
{
  const res = await call({
    model: "officeace/glm-5.2",
    stream: true,
    max_tokens: 512,
    messages: [{ role: "user", content: "从1数到5, 只输出数字" }],
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = "";
  let content = "";
  let reasoning = "";
  let chunks = 0;
  let buf = "";
  const feed = (text) => {
    buf += text;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const o = JSON.parse(p);
        chunks++;
        content += o.choices?.[0]?.delta?.content ?? "";
        reasoning += o.choices?.[0]?.delta?.reasoning_content ?? "";
      } catch {}
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    raw += s;
    feed(s);
  }
  console.log(`  SSE 事件=${chunks} content=${JSON.stringify(content.slice(0, 60))} reasoning=${reasoning.length}字`);
  check("是 SSE", raw.includes("data:"));
  check("有增量(content 或 reasoning)", content.length + reasoning.length > 0);
  check("有 [DONE]", raw.includes("[DONE]"));
  check("增量是逐字的(>5 个事件)", chunks > 5, `实际 ${chunks}`);
}

console.log("\n== 直连: 工具调用 ==");
{
  const res = await call({
    model: "officeace/glm-5.2",
    stream: false,
    max_tokens: 512,
    messages: [{ role: "user", content: "北京现在天气怎么样？用工具查。" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询指定城市的天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
  });
  const j = await res.json();
  const tc = j.choices?.[0]?.message?.tool_calls;
  console.log(`  finish_reason=${j.choices?.[0]?.finish_reason} tool_calls=${JSON.stringify(tc)?.slice(0, 200)}`);
  check("原生返回 tool_calls", Array.isArray(tc) && tc.length > 0);
  if (tc?.[0]) {
    let parsedOk = false;
    try {
      parsedOk = typeof JSON.parse(tc[0].function.arguments) === "object";
    } catch {}
    check("arguments 是合法 JSON", parsedOk);
  }
}

console.log("\n== provider.models (默认: 与 OfficeAce 界面一致) ==");
{
  const ms = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: authz.key } });
  const ids = Object.keys(ms);
  console.log(`  暴露 ${ids.length} 个: ${ids.join(", ")}`);
  check("默认不暴露网关测试模型", !ids.some((i) => /-test-|-test$|-bnt|-zx|-a3|harmony/.test(i)));
  check("含 agent", "agent" in ms);
  check("数量不多(<=6)", ids.length <= 6, `实际 ${ids.length}`);
  check("推理模型带档位", Array.isArray(ms["glm-5.2"]?.variants ? Object.keys(ms["glm-5.2"].variants) : null) || Object.keys(ms["glm-5.2"]?.variants ?? {}).length > 0);
  check("档位含 none/max", "none" in (ms["glm-5.2"]?.variants ?? {}) && "max" in (ms["glm-5.2"]?.variants ?? {}));
  check("档位带 reasoningEffort", ms["glm-5.2"]?.variants?.high?.reasoningEffort === "high");

  process.env.MAGPIE_OFFICEACE_MODELS = "all";
  const all = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: authz.key } });
  delete process.env.MAGPIE_OFFICEACE_MODELS;
  const allIds = Object.keys(all);
  console.log(`  MAGPIE_OFFICEACE_MODELS=all -> ${allIds.length} 个`);
  check("all 模式给出网关全量", allIds.length > ids.length);
}

console.log("\n== 单元: 不思考模型剔除档位 ==");
{
  const b = { model: "x", reasoning_effort: "high", messages: [] };
  check("推理模型保留", _internal.stripUnsupportedEffort(b, "glm-5.2").reasoning_effort === "high");
  check("非推理模型摘掉", _internal.stripUnsupportedEffort(b, "kimi-k2.6").reasoning_effort === undefined);
}

console.log("\n== 直连: 思考档位真的生效 ==");
{
  const ask = async (effort) => {
    const res = await call({
      model: "officeace/glm-5.2",
      stream: false,
      max_tokens: 1500,
      messages: [{ role: "user", content: "一个笼子里有鸡和兔共35只，脚共94只，问鸡兔各几只？" }],
      ...(effort ? { reasoning_effort: effort } : {}),
    });
    const j = await res.json();
    return j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  };
  const none = await ask("none");
  const high = await ask("high");
  const max = await ask("max");
  console.log(`  reasoning_tokens: none=${none}  high=${high}  max=${max}`);
  check("none 不思考", none === 0);
  check("档位越高思考越多", high > none && max >= high);
}

if (withAgent) {
  console.log("\n== 智能体兜底链路 ==");
  const t0 = Date.now();
  const res = await call({
    model: "officeace/agent",
    stream: false,
    messages: [{ role: "user", content: "只回复两个字母: OK" }],
  });
  const j = await res.json();
  console.log(`  status=${res.status} ${Date.now() - t0}ms`);
  console.log(`  content=${JSON.stringify(j.choices?.[0]?.message?.content)?.slice(0, 80)}`);
  console.log(`  usage=${JSON.stringify(j.usage)}`);
  check("智能体链路可用", res.status === 200 && typeof j.choices?.[0]?.message?.content === "string");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
