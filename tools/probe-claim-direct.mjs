// 直连订阅接口实验: V11-HMAC-SHA256 签名(无 STS 变体), 先打只读 GET /v1/subscription
// 凭据: routing_state 的 Basic(ak:sk) + metadata.json 的 project_id
//   bun tools/probe-claim-direct.mjs [claim]
// 带 claim 参数时才打 POST index-bonus(幂等, 今日未签会 +1000)
import { createHmac, createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverGateway } from "../lib/gateway.mjs";

const REGION = process.env.MAGPIE_OFFICEACE_REGION || "cn-southwest-2";

// ── 凭据收集(只打印脱敏信息) ──────────────────────────────────────

function basicToKeypair(authorization) {
  const b64 = String(authorization).replace(/^Basic\s+/i, "");
  let raw;
  try {
    raw = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = raw.indexOf(":");
  if (colon > 0) return { ak: raw.slice(0, colon), sk: raw.slice(colon + 1) };
  // 无冒号: 尝试 20 字符 AK 前缀
  if (raw.length > 24) return { ak: raw.slice(0, 20), sk: raw.slice(20) };
  return null;
}

function findProjectId() {
  const root = join(homedir(), ".office-claw", ".jiuwenclaw", "service_default", "agent_office", "agent", "sessions");
  if (!existsSync(root)) return "";
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("officeclaw_"))
    .map((d) => join(root, d.name));
  for (const dir of dirs.slice().reverse()) {
    const f = join(dir, "metadata.json");
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      const p = j?.project_id ?? j?.projectId ?? j?.project?.id ?? j?.data?.project_id ?? "";
      if (p) return p;
    } catch {}
  }
  return "";
}

// ── V11-HMAC-SHA256 签名(migrated from build_iam_v11_headers) ──────

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const quotePath = (s) => encodeURIComponent(s).replace(/%7E/g, "~");
const quoteQuery = (s) => encodeURIComponent(s).replace(/%7E/g, "~");

function canonicalUri(endpoint) {
  const path = new URL(endpoint).pathname || "/";
  const parts = path.split("/").map((p) => (p === "" ? "" : quotePath(decodeURIComponent(p))));
  let out = parts.join("/");
  if (!out.endsWith("/")) out += "/";
  return out;
}
function canonicalQuery(endpoint) {
  const pairs = [...new URL(endpoint).searchParams.entries()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return pairs.map(([k, v]) => `${quoteQuery(k)}=${quoteQuery(v)}`).join("&");
}

function v11Headers(method, endpoint, body, { ak, sk, projectId, token = "" }) {
  const parsed = new URL(endpoint);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const sdkDate = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const headers = {
    host: parsed.host,
    "x-sdk-date": sdkDate,
    "x-security-token": token,
    "x-project-id": projectId,
  };
  headers["content-type"] = "application/json";
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
    "X-Security-Token": token,
    "X-Project-ID": projectId,
    "Content-Type": "application/json",
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────

const gw = discoverGateway();
if (!gw.authorization) {
  console.error("无网关凭据");
  process.exit(1);
}
const kp = basicToKeypair(gw.authorization);
const projectId = findProjectId();
console.log("网关 base:", gw.base.split("/")[2]);
console.log("AK:", kp ? `${kp.ak.slice(0, 4)}…(${kp.ak.length})` : "解析失败");
console.log("project_id:", projectId ? `${projectId.slice(0, 6)}…(${projectId.length})` : "(未找到)");

const origin = new URL(gw.base).origin;
const wantClaim = process.argv[2] === "claim";

async function signed(method, path, payload) {
  const url = `${origin}${path}`;
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  const h = v11Headers(method, url, body, { ak: kp.ak, sk: kp.sk, projectId });
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...h },
    ...(body.length ? { body } : {}),
  });
  return { status: res.status, text: (await res.text()).slice(0, 600) };
}

console.log("\n== 1) 只读 GET /v1/subscription(验签) ==");
let r = await signed("GET", "/v1/subscription", undefined);
console.log(r.status, r.text.replace(/\s+/g, " ").slice(0, 500));

if (r.status === 200) {
  console.log("\n== 2) 签名有效; 只读 GET /v1/model-token-rates ==");
  r = await signed("GET", "/v1/model-token-rates", undefined);
  console.log(r.status, r.text.replace(/\s+/g, " ").slice(0, 300));
}

if (wantClaim) {
  console.log("\n== 3) POST /v1/subscription/bonus/claim(签到, 幂等) ==");
  r = await signed("POST", "/v1/subscription/bonus/claim", {});
  console.log(r.status, r.text.replace(/\s+/g, " ").slice(0, 500));
} else {
  console.log("\n(传 claim 参数才执行签到动作)");
}