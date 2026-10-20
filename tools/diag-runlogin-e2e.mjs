// 端到端验证修复版 runCloudLogin: 浏览器 SSO -> code -> token -> magpie success 结果
// 输出做掩码, 只验结构
import { runCloudLogin } from "../lib/oauth.mjs";

const res = await runCloudLogin({}, { log: { info: (m) => console.log("[info]", m) } });
console.log("type:", res.type);
if (res.type !== "success") {
  console.log("error:", res.error);
  process.exit(1);
}
const m = res.metadata ?? {};
const mask = (s) => (s ? `${String(s).slice(0, 6)}…(${String(s).length})` : "(空)");
console.log("accountId:", res.accountId);
console.log("key:", res.key);
console.log("iamAccessKey:", mask(m.iamAccessKey));
console.log("iamSecretKey:", mask(m.iamSecretKey));
console.log("iamSecurityToken:", mask(m.iamSecurityToken));
console.log("iamProjectId:", m.iamProjectId ? mask(m.iamProjectId) : "(空)");
console.log("oauthRefreshToken:", mask(m.oauthRefreshToken));
console.log("oauthExpiresAt:", m.oauthExpiresAt ? new Date(m.oauthExpiresAt).toISOString() : "(空)");
const in2h = m.oauthExpiresAt - Date.now();
console.log("距过期:", in2h > 0 ? `${Math.round(in2h / 60000)} 分钟` : `已过期 ${Math.abs(Math.round(in2h / 60000))} 分钟`);
console.log("dpopPrivateJwk:", m.dpopPrivateJwk ? "ok" : "(缺)");
console.log("dpopPublicJwk:", m.dpopPublicJwk ? "ok" : "(缺)");
