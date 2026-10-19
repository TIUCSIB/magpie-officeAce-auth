// 裸打网关, 看原始回包(不带插件)。确认网关行为或上游变更时用。
//   bun tools/probe-gateway.mjs [模型]
// 凭据走 lib/gateway.mjs 的发现逻辑(env / routing_state / 本机私有文件), 源码里没有硬编码。
import { discoverGateway, gatewayHeaders, gatewayUrl, NO_AUTH_HINT } from "../lib/gateway.mjs";

const gw = discoverGateway();
const MODEL = process.argv[2] || "deepseek-v4.1-flash";

if (!gw.authorization) {
  console.error(NO_AUTH_HINT);
  process.exit(1);
}
console.log(`网关: ${gw.base}\n凭据来源: ${gw.source}\n模型: ${MODEL}\n`);

const chat = async (extra = {}) => {
  const r = await fetch(gatewayUrl(gw, "/chat/completions"), {
    method: "POST",
    headers: gatewayHeaders(gw),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.6,
      messages: [{ role: "user", content: "只回复两个字母: OK" }],
      ...extra,
    }),
  });
  return { status: r.status, body: await r.text() };
};

console.log("== 1) 非流式 ==");
let r = await chat();
console.log(r.status, r.body.slice(0, 900));

console.log("\n== 2) 流式 ==");
r = await chat({ stream: true });
console.log(r.status, "总字节", r.body.length, "| 含 [DONE]:", r.body.includes("[DONE]"));
console.log(r.body.slice(0, 400));

console.log("\n== 3) 工具调用 ==");
r = await chat({
  messages: [{ role: "user", content: "北京现在天气怎么样？用工具查。" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "查天气",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }],
});
console.log(r.body.slice(0, 700));

console.log("\n== 4) 思考档位 (网关枚举: none,minimal,low,medium,high,xhigh,max) ==");
console.log("   注意: 档位是否生效看模型 —— glm-5.2 严格听话, deepseek-v4.1-flash 基本无视");
for (const e of ["none", "low", "medium", "high", "max"]) {
  const x = await chat({
    reasoning_effort: e,
    max_tokens: 3000,
    messages: [{ role: "user", content: "一个笼子里有鸡和兔共35只，脚共94只，问鸡兔各几只？" }],
  });
  let rt = "-";
  try {
    rt = JSON.parse(x.body).usage?.completion_tokens_details?.reasoning_tokens;
  } catch {}
  console.log(`  reasoning_effort=${e.padEnd(8)} status=${x.status} reasoning_tokens=${rt}`);
}

console.log("\n== 5) /models ==");
const m = await fetch(gatewayUrl(gw, "/models"), { headers: gatewayHeaders(gw) });
console.log(m.status, (await m.text()).slice(0, 300));
