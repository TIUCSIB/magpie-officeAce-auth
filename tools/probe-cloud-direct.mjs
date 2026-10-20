// 纯云端 OAuth 探针(完全不经过 OfficeAce 本地 API)
// 验证: state 签发 / authorizeUrl 构造 / code poll 可达
import { createHash, randomBytes, webcrypto } from "node:crypto";

const CLAW = "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const AUTH = "https://auth.huaweicloud.com";
const CLIENT_ID = "pdp5_for_agentarts";
const REDIRECT = `${CLAW}/v1/claw/auth/callback`;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

const stateRes = await fetch(`${CLAW}/v1/claw/auth/state`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
console.log("POST /v1/claw/auth/state ->", stateRes.status);
const stateData = await stateRes.json().catch(() => ({}));
const state = String(stateData.state ?? "").trim();
console.log("state:", state ? `${state.slice(0, 8)}…(${state.length})` : "(无)", "| 响应键:", Object.keys(stateData).join(","));

if (!state) process.exit(1);

// PKCE + DPoP(本地自持)
const codeVerifier = b64u(randomBytes(32));
const codeChallenge = b64u(createHash("sha256").update(codeVerifier).digest());
const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const dpopPublicJwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
console.log("PKCE/DPoP: 本地生成 OK (crv=", dpopPublicJwk.crv + ")");

const params = new URLSearchParams({
  client_id: CLIENT_ID,
  code_challenge: codeChallenge,
  code_challenge_method: "SHA-256",
  state,
  scope: "openid",
  redirect_uri: REDIRECT,
  response_type: "code",
});
const authorizeUrl = `${AUTH}/authui/login.html?service=${encodeURIComponent(`${AUTH}/authui/v1/oauth2/authorize?${params}`)}`;
console.log("\nauthorizeUrl(前 160):", authorizeUrl.slice(0, 160), "…");

// poll 未就绪探测(用户还没登录, 预期 202/404 not-ready)
const poll = await fetch(`${CLAW}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, { headers: { Accept: "application/json" } });
console.log("\nGET /v1/claw/auth/code?state= ->", poll.status, (await poll.text()).slice(0, 200).replace(/\s+/g, " "));

console.log("\n结论: 若上面 state 签发与 poll 可达 => 完全脱离 OfficeAce 的自持 OAuth 可实现。");
console.log("(authorizeUrl 已生成——真实登录验证放到插件 v5 里做)");