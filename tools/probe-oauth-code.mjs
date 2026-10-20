// 实测 OAuth 授权码流的本地端点结构(不动手完成登录, 只看响应)
import https from "node:https";
import { discoverSession, cookieHeader } from "../lib/cookie.mjs";

const BASE = process.env.MAGPIE_OFFICEACE_BASE || "https://127.0.0.1:3004";
const COOKIE = cookieHeader(discoverSession().cookie);

function req(path, { method = "GET", body, withCookie = true } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
    const headers = { Accept: "application/json" };
    if (withCookie) headers.Cookie = COOKIE;
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
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: buf, setCookie: res.headers["set-cookie"] }),
        );
      },
    );
    r.setTimeout(20000, () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (payload) r.write(payload);
    r.end();
  });
}

const brief = (o) => o.body.slice(0, 500).replace(/\s+/g, " ");

console.log("BASE:", BASE);
const islogin = await req("/api/islogin");
console.log("\n== GET /api/islogin == HTTP", islogin.status, "\n ", brief(islogin));

const authz = await req("/api/login/authorize", { method: "POST", body: { persist: false } });
console.log("\n== POST /api/login/authorize {persist:false} == HTTP", authz.status, "\n ", brief(authz));
let state = "";
try {
  const j = JSON.parse(authz.body);
  state = j.state ?? new URL(j.authorizeUrl ?? "").searchParams.get("state") ?? "";
  if (j.authorizeUrl) console.log("  authorizeUrl:", j.authorizeUrl.slice(0, 400));
} catch {}

if (state) {
  const poll = await req(`/api/login/oauth/poll?state=${encodeURIComponent(state)}`);
  console.log("\n== GET /api/login/oauth/poll?state=... == HTTP", poll.status, "\n ", brief(poll));
} else {
  console.log("\n(没有 state, 跳过 poll 探测)");
}