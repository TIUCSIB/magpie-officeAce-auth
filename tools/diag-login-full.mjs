// 完整登录链路诊断: state -> PKCE -> DPoP -> 浏览器 -> code -> token 交换(打印完整原始响应)
// 目的: 定位 token 交换 HTTP 200 但 hasAccess=false 的真实原因
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CLAW = "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const AUTH = "https://auth.huaweicloud.com";
const IAM_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const CLIENT_ID = "pdp5_for_agentarts";
const REDIRECT = `${CLAW}/v1/claw/auth/callback`;
const NO_OPEN = process.argv.includes("--no-open");
const b64u = (buf) => Buffer.from(buf).toString("base64url");

const stateRes = await fetch(`${CLAW}/v1/claw/auth/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const state = String((await stateRes.json()).state ?? "").trim();
if (!state) { console.error("state 签发失败"); process.exit(1); }
console.log("state:", state);

const codeVerifier = b64u(randomBytes(32));
const codeChallenge = b64u(createHash("sha256").update(codeVerifier).digest());
const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);

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
console.log("authorizeUrl:", authorizeUrl);

if (!NO_OPEN) {
  spawn("cmd", ["/c", "start", "", authorizeUrl], { detached: true, stdio: "ignore" }).unref();
  console.log("(浏览器已打开, 请完成华为云登录)");
}

// 轮询 code
const deadline = Date.now() + 180_000;
let code = "";
let lastCode = "";
let polls = 0;
while (Date.now() < deadline) {
  const r = await fetch(`${CLAW}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, { headers: { Accept: "application/json" } });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { console.log(`[poll ${++polls}] HTTP ${r.status} 非 JSON: ${text.slice(0, 80)}`); }
  if (j) {
    if (typeof j.code === "string" && j.code) { code = j.code; break; }
    if (j.error_code !== lastCode) console.log(`[poll ${++polls}] HTTP ${r.status} ${j.error_code ?? ""}`);
  }
  await new Promise((r2) => setTimeout(r2, 2000));
}
if (!code) { console.error("超时: 没拿到 code"); process.exit(2); }
console.log("\n拿到 code:", code.slice(0, 12) + "…", `(${code.length} 字符)`);

// DPoP
async function dpop() {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } };
  const payload = { htm: "POST", htu: IAM_TOKEN_URL, iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString("hex") };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

const form = new URLSearchParams({
  client_id: CLIENT_ID,
  code,
  code_verifier: codeVerifier,
  grant_type: "authorization_code",
  redirect_uri: REDIRECT,
});
const tr = await fetch(IAM_TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", DPoP: await dpop() },
  body: form.toString(),
});
const raw = await tr.text();
console.log("\n=== token 交换 HTTP", tr.status, "===");
console.log("响应 Content-Type:", tr.headers.get("content-type"));
console.log("响应头:", JSON.stringify([...tr.headers].slice(0, 12)));
console.log("原始响应体(前 4000 字符):");
console.log(raw.slice(0, 4000));

writeFileSync(process.env.TEMP + "\\oa-token-raw.json", raw);
console.log("\n(原始响应已存到 %TEMP%\\oa-token-raw.json)");
