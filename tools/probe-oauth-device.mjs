// 探测本地 API 的 OAuth 设备码端点(逆向用)
//   bun tools/probe-oauth-device.mjs
import https from "node:https";
import { discoverSession } from "../lib/cookie.mjs";
import { cookieHeader } from "../lib/cookie.mjs";

const BASE = process.env.MAGPIE_OFFICEACE_BASE || "https://127.0.0.1:3004";
const COOKIE = cookieHeader(discoverSession().cookie);

function req(path, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
    const headers = { Accept: "application/json", Cookie: COOKIE };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const r = https.request(
      { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, rejectUnauthorized: false },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    r.setTimeout(15000, () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (payload) r.write(payload);
    r.end();
  });
}

const providers = ["huawei", "huawei-maas", "huawei_maas", "huawei-cloud", "huawei-cloud-iam", "huaweicloud", "codearts", "modelarts", "maas", "officeace"];

console.log(`== 本地 API ${BASE} ==`);
for (const p of providers) {
  const r = await req("/api/oauth/device/authorize", { method: "POST", body: { provider_id: p } });
  let brief = r.body.slice(0, 220).replace(/\s+/g, " ");
  console.log(`\n[${p}] HTTP ${r.status}: ${brief}`);
  if (r.body.includes("device_code")) {
    console.log(`   <<< ${p} 有效!`);
    break;
  }
}
const r2 = await req("/api/oauth/device/token?device_code=test-deadbeef");
console.log(`\n[直接 poll 假码] HTTP ${r2.status}: ${r2.body.slice(0, 220)}`);