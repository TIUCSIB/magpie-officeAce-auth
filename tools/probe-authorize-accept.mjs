// 探针: 华为云 authorize 端点是否接受插件的参数
// 未登录时预期: 302/200 指向登录页; 若参数非法会直接返回错误 JSON
import { createHash, randomBytes } from "node:crypto";

const AUTH = "https://auth.huaweicloud.com";
const CLAW = "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const REDIRECT = `${CLAW}/v1/claw/auth/callback`;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const codeChallenge = b64u(createHash("sha256").update(b64u(randomBytes(32))).digest());

const params = new URLSearchParams({
  client_id: "pdp5_for_agentarts",
  code_challenge: codeChallenge,
  code_challenge_method: "SHA-256",
  state: "probe-" + Date.now(),
  scope: "openid",
  redirect_uri: REDIRECT,
  response_type: "code",
});
const authorizeUrl = `${AUTH}/authui/v1/oauth2/authorize?${params}`;
console.log("GET", authorizeUrl.slice(0, 140), "…\n");

const res = await fetch(authorizeUrl, { redirect: "manual" });
console.log("status:", res.status);
console.log("location:", res.headers.get("location") ?? "(无)");
const text = await res.text();
console.log("body(前 500):", text.slice(0, 500).replace(/\s+/g, " "));
