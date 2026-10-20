// 最终端到端: 登录 -> metadata 网关凭据 -> 打 /v2/chat/completions 期望 200
// 同时验证 loader 的凭据选择逻辑(gatewayOf 等价)
import { runCloudLogin } from "../lib/oauth.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
const m = res.metadata ?? {};
console.log("登录: success");
console.log("gatewayBase:", m.gatewayBase || "(缺)");
console.log("gatewayAuthorization:", m.gatewayAuthorization ? `${String(m.gatewayAuthorization).slice(0, 18)}…(${String(m.gatewayAuthorization).length})` : "(缺)");
console.log("expires:", new Date(res.expires).toISOString());

if (!m.gatewayBase || !m.gatewayAuthorization) { console.error("metadata 缺网关凭据!"); process.exit(1); }

const r = await fetch(`${m.gatewayBase}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: m.gatewayAuthorization },
  body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "只回复: OK" }], max_tokens: 16 }),
});
const text = await r.text();
console.log("网关 chat/completions ->", r.status, text.slice(0, 200).replace(/\s+/g, " "));
process.exit(r.status === 200 ? 0 : 1);
