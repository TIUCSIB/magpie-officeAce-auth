// 实验: 用 routing_state 的 AK/SK(无 STS) 调 IAM securitytokens 换临时 STS
// 若成功 -> 签到/订阅直连闭环(不需要 OfficeAce)
import { createHmac, createHash } from "node:crypto";
import { discoverGateway } from "../lib/gateway.mjs";

const IAM = "https://iam.myhuaweicloud.com/v3.0/OS-CREDENTIAL/securitytokens";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const qenc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (t) => `%${t.charCodeAt(0).toString(16).toUpperCase()}`);

function basicToKeypair(authorization) {
  const raw = Buffer.from(String(authorization).replace(/^Basic\s+/i, ""), "base64").toString("utf8");
  const c = raw.indexOf(":");
  if (c > 0) return { ak: raw.slice(0, c), sk: raw.slice(c + 1) };
  return null;
}

function sdkHeaders(method, url, body, { ak, sk }) {
  const parsed = new URL(url);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const sdkDate = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const lower = {
    host: parsed.host,
    "x-sdk-date": sdkDate,
    "content-type": "application/json",
  };
  const names = Object.keys(lower).sort();
  const cHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const uri = (parsed.pathname || "/").split("/").map((s) => qenc(decodeURIComponent(s))).join("/") || "/";
  const canonical = [
    method.toUpperCase(),
    uri,
    "",
    cHeaders,
    names.join(";"),
    sha256hex(body),
  ].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", sdkDate, sha256hex(Buffer.from(canonical))].join("\n");
  const sig = createHmac("sha256", sk).update(stringToSign).digest("hex");
  return {
    "X-Sdk-Date": sdkDate,
    "Content-Type": "application/json",
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${names.join(";")}, Signature=${sig}`,
  };
}

const gw = discoverGateway();
const kp = basicToKeypair(gw.authorization);
console.log("AK:", `${kp.ak.slice(0, 4)}…(${kp.ak.length})`);

const attempts = [
  { label: "methods=[aksk]", body: { auth: { identity: { methods: ["aksk"], aksk: { duration_seconds: 3600 } } } } },
  { label: "methods=[token] 带 duration", body: { auth: { identity: { methods: ["token"], token: { duration_seconds: 3600 } } } } },
  { label: "空 auth", body: { auth: {} } },
];

for (const a of attempts) {
  const bodyStr = JSON.stringify(a.body);
  const h = sdkHeaders("POST", IAM, Buffer.from(bodyStr), kp);
  const res = await fetch(IAM, { method: "POST", headers: { Accept: "application/json", ...h }, body: bodyStr });
  const text = (await res.text()).slice(0, 400);
  console.log(`\n[${a.label}] HTTP ${res.status}: ${text.replace(/\s+/g, " ")}`);
  if (res.status === 201 || res.status === 200) {
    console.log("  <<< STS 获取成功!");
    break;
  }
}