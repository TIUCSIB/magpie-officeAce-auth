// 验证: 订阅响应 model_infos 的 app_key/secret 组 Basic 打网关 -> 期望 200
import { runCloudLogin } from "../lib/oauth.mjs";
import { iamCredentialOf, clawRequest } from "../lib/cloud.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
const iam = iamCredentialOf(res);

const sub = await clawRequest(iam, "GET", "/v1/subscription", undefined);
const info = sub.json?.model_infos?.[0];
if (!info) { console.error("无 model_infos"); process.exit(1); }
const { model_app_key: ak, model_app_secret: sk } = info.model_auth_info ?? {};
const base = `https://${info.model_api_url_base}`;
console.log("网关凭据: app_key=%s… base=%s", String(ak).slice(0, 8), base);

const gwAuth = `Basic ${Buffer.from(`${ak}:${sk}`).toString("base64")}`;
const r = await fetch(`${base}/v2/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: gwAuth },
  body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "回复OK" }], max_tokens: 8 }),
});
const text = await r.text();
console.log("网关 /v2/chat/completions ->", r.status, text.slice(0, 220).replace(/\s+/g, " "));
