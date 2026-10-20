// 华为云直连工具集(不依赖 OfficeAce 本地 API)
// - V11-HMAC-SHA256 请求签名(与 OfficeClaw Wish Wall / skill-submit 同算法)
// - 订阅/积分/签到直连(POST /v1/subscription/bonus/claim 等)
// 凭据: IAM 临时凭证 {accessKey, secretKey, securityToken, projectId}
import { createHmac, createHash } from "node:crypto";

const REGION = process.env.MAGPIE_OFFICEACE_REGION || "cn-southwest-2";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const qenc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (t) => `%${t.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalUri(endpoint) {
  const path = new URL(endpoint).pathname || "/";
  const parts = path.split("/").map((p) => (p === "" ? "" : qenc(decodeURIComponent(p))));
  let out = parts.join("/");
  if (!out.endsWith("/")) out += "/";
  return out;
}
function canonicalQuery(endpoint) {
  const pairs = [...new URL(endpoint).searchParams.entries()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return pairs.map(([k, v]) => `${qenc(k)}=${qenc(v)}`).join("&");
}

/** V11-HMAC-SHA256 签名头 */
export function v11Headers(method, endpoint, body, { ak, sk, projectId, token }) {
  const parsed = new URL(endpoint);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const sdkDate = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const headers = {
    host: parsed.host,
    "x-sdk-date": sdkDate,
    "x-security-token": token ?? "",
    ...(projectId ? { "x-project-id": projectId } : {}),
    "content-type": "application/json",
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join("");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(endpoint),
    canonicalQuery(endpoint),
    canonicalHeaders,
    signedNames.join(";"),
    sha256hex(body),
  ].join("\n");
  const scope = `${sdkDate.slice(0, 8)}/${REGION}/apic`;
  const stringToSign = ["V11-HMAC-SHA256", sdkDate, scope, sha256hex(Buffer.from(canonicalRequest))].join("\n");
  const prk = createHmac("sha256", ak).update(sk).digest();
  const derivedKeyHex = createHmac("sha256", prk).update(Buffer.concat([Buffer.from(scope), Buffer.from([1])])).digest("hex");
  const signature = createHmac("sha256", derivedKeyHex).update(stringToSign).digest("hex");
  return {
    Authorization: `V11-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
    "X-Sdk-Date": sdkDate,
    "X-Security-Token": token ?? "",
    ...(projectId ? { "X-Project-ID": projectId } : {}),
    "Content-Type": "application/json",
  };
}

/** 从 magpie 账号对象提取 IAM 凭据; 无则 null */
export function iamCredentialOf(authLike) {
  const m = authLike?.metadata ?? {};
  const ak = m.iamAccessKey ?? "";
  const sk = m.iamSecretKey ?? "";
  const token = m.iamSecurityToken ?? "";
  const projectId = m.iamProjectId ?? "";
  if (!ak || !sk || !token) return null;
  return { ak, sk, token, projectId };
}

/**
 * 直连华为云 claw 接口(V11 签名)。
 * path 例: /v1/subscription, /v1/subscription/bonus/claim
 */
export async function clawRequest(cred, method, path, payload, { origin } = {}) {
  // 订阅/签到 API 只发布在 modelgw 这个 APIG 环境上(agentarts/versatile 域同路径
  // 实测 404 APIGW.0101 "API does not exist or has not been published");
  // 与网关模型 API 同域, 但不带 /v2 路径前缀。
  const base =
    origin ||
    process.env.MAGPIE_OFFICEACE_CLOUD_ORIGIN ||
    "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com";
  const url = `${base}${path}`;
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  const headers = v11Headers(method, url, body, cred);
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...headers },
    ...(body.length ? { body } : {}),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, body: text };
}

/** 订阅余额(直连, 只读) */
export async function readSubscriptionDirect(cred) {
  const r = await clawRequest(cred, "GET", "/v1/subscription", undefined, {
    origin: cred.origin,
  });
  if (r.status !== 200 || !r.json) return { ok: false, error: `HTTP ${r.status} ${String(r.body).slice(0, 160)}` };
  return { ok: true, data: r.json };
}

/** 每日签到(直连, 服务端幂等) */
export async function claimBonusDirect(cred) {
  const r = await clawRequest(cred, "POST", "/v1/subscription/bonus/claim", {}, { origin: cred.origin });
  if (r.status !== 200 || !r.json) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.body ?? "").slice(0, 200)}` };
  }
  const skus = Array.isArray(r.json.bonus_skus) ? r.json.bonus_skus : [];
  const points = skus.reduce((a, s) => a + (Number(s?.points) || 0), 0);
  return { ok: true, points, skus };
}