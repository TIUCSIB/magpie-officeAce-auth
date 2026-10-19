// 模拟: 磁盘上没有任何 OfficeAce 运行痕迹(没有 routing_state, 没有 session.cookie)
process.env.MAGPIE_OFFICEACE_ROUTING_ROOT = "C:\\__no_such_dir__\\routing_state\\users";
process.env.MAGPIE_OFFICEACE_COOKIE_FILE = "C:\\__no_such_dir__\\session.cookie";
process.env.MAGPIE_OFFICEACE_GATEWAY_AUTH = "";

const { OfficeAcePlugin } = await import("../index.mjs");
const { discoverGateway } = await import("../lib/gateway.mjs");

const gw = discoverGateway();
console.log("凭据来源 :", gw.source);
console.log("网关地址 :", gw.base);

const hooks = await OfficeAcePlugin({ client: { app: { log: (x) => console.log("   [log]", x.body.message) } } });
const a = await hooks.auth.methods[0].authorize({});
console.log("authorize:", a.type, a.type === "failed" ? a.error : JSON.stringify(a.metadata));

const loaded = await hooks.auth.loader(async () => ({ type: "api", key: a.key }));
const res = await loaded.fetch("https://officeace.local/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "officeace/glm-5.2", stream: false, max_tokens: 256,
    messages: [{ role: "user", content: "只回复两个字母: OK" }] }),
});
const j = await res.json();
console.log("直连 status =", res.status, "| usage =", JSON.stringify(j.usage));
console.log("回答 =", JSON.stringify(j.choices?.[0]?.message?.content)?.slice(0, 60));
