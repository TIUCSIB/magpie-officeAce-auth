// OfficeAce 真 OAuth 登录 — 华为云统一认证授权码流 (RFC 6749 + PKCE)
//
// 依据: 逆向 packages/api(3004) 的登录模块 + 渲染层 LoginPage/LoginCallbackPage。
//   1) POST /api/login/authorize {persist:false}
//         -> { authorizeUrl: "https://auth.huaweicloud.com/authui/login.html?service=…" }
//        其中 service 内嵌完整 OAuth authorize 参数:
//          client_id=pdp5_for_agentarts & code_challenge(SHA-256) & scope=openid
//          & state=… & response_type=code
//          & redirect_uri=https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback
//   2) 用户在华为云登录页完成登录(真 OAuth, 云端回调)
//   3) GET /api/login/oauth/poll?state=…  轮询, 授权完成前返回 202 not-ready,
//      完成后返回 { code }(云端已把授权码就位)
//   4) POST /api/login/callback {code, state} -> { success, userId, userName }
//      完成本机会话(等价于桌面端登录), 之后 islogin/本机 cookie 即新会话
//
// magpie 侧按官方 oauth 契约: authorize 返回 {url, method:"auto", instructions, callback},
// 成功只在 callback 里返回。成功结果带 key=auto -> magpie 按凭据保存,
// accountId=userName 作账号名。
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { appendFileSync } from "node:fs";
import { discoverSession, cookieFilePath } from "./cookie.mjs";
import { makeClient } from "./agent.mjs";
import { discoverGateway } from "./gateway.mjs";

const POLL_MS = () => Math.max(500, Number(process.env.MAGPIE_OFFICEACE_OAUTH_POLL_MS || 1500));
const POLL_TIMEOUT_MS = () => Number(process.env.MAGPIE_OFFICEACE_OAUTH_TIMEOUT_MS || 300000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 磁盘日志: magpie GUI 看不到插件日志, 关键步骤追加到 %TEMP%\magpie-officeace-oauth.log
const LOG_FILE = joinPath(tmpdir(), "magpie-officeace-oauth.log");
function diskLog(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ── 从 authorizeUrl(登录页)里取出内嵌 OAuth state ──────────────────

function stateOf(authorizeUrl) {
  try {
    const outer = new URL(authorizeUrl);
    const service = outer.searchParams.get("service");
    if (service) {
      const inner = new URL(service);
      return inner.searchParams.get("state") ?? "";
    }
    return outer.searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

// ── 会话验证(取账号名) ─────────────────────────────────────────────

async function validateSession(cookie) {
  if (!cookie) return { accountId: "", session: "unavailable" };
  try {
    const info = await makeClient(cookie).isLogin();
    const d = info.data;
    if (!d?.islogin) return { accountId: "", session: d ? "not-logged-in" : "unknown" };
    return {
      accountId: String(d.userName ?? "").trim(),
      session: d.needsReauth === true ? "needs-reauth" : "ok",
    };
  } catch {
    return { accountId: "", session: "local-api-unreachable" };
  }
}

function okResult({ key, accountId, session, via }) {
  const gw = discoverGateway();
  return {
    type: "success",
    key,
    ...(accountId ? { accountId } : {}),
    metadata: { gateway: gw.base, gatewayAuth: gw.source, session, via },
  };
}

// ── oauth authorize 主流程 ──────────────────────────────────────────

export async function oauthAuthorize(inputs = {}, { log } = {}) {
  // 读本机 oc_sid 作请求凭据(可选: authorize 不需要登录态, 带上更稳)
  let cookie = "";
  try {
    cookie = discoverSession().cookie;
  } catch {}
  const client = makeClient(cookie);
  diskLog(`authorize 开始 cookie=${cookie ? "有" : "无"} inputs=${JSON.stringify(Object.keys(inputs ?? {}))}`);

  // 1) 发起授权请求
  let authz;
  try {
    authz = await client.call("/api/login/authorize", {
      method: "POST",
      body: { persist: false },
      timeout: 20000,
    });
  } catch (err) {
    diskLog(`authorize 调用失败: ${err?.message ?? err}`);
    return {
      type: "failed",
      error: `发起华为云登录失败(先打开 OfficeAce): ${err?.message ?? err}`,
    };
  }
  const url = authz?.json?.authorizeUrl;
  if (authz.status !== 200 || typeof url !== "string" || !url) {
    diskLog(`authorize 响应异常: HTTP ${authz.status} ${String(authz.body ?? "").slice(0, 200)}`);
    return { type: "failed", error: "没拿到华为云登录地址(检查 OfficeAce 登录态)" };
  }
  const state = stateOf(url);
  diskLog(`authorizeUrl=${url.slice(0, 120)}… state=${state || "(无)"}`);
  log?.info?.(`华为云登录页: ${url}`);

  // 2) magpie 契约: 浏览器结果 + callback 收尾
  return {
    url,
    instructions: "请在打开的华为云登录页完成登录; 授权后将自动完成。",
    method: "auto",
    opened: false,
    callback: async () => {
      try {
        const deadline = Date.now() + POLL_TIMEOUT_MS();
        for (;;) {
          if (Date.now() > deadline) {
            diskLog("callback 轮询超时");
            return { type: "failed", error: `等待华为云授权超时(${Math.round(POLL_TIMEOUT_MS() / 1000)}s)。请重试。` };
          }
          let r = null;
          try {
            r = await client.call(`/api/login/oauth/poll?state=${encodeURIComponent(state)}`, { timeout: 8000 });
          } catch {
            // 本地 API 抖动, 继续
          }
          const j = r?.json;
          const code = j && typeof j.code === "string" ? j.code : "";
          if (code) {
            const cb = await client.call("/api/login/callback", {
              method: "POST",
              body: { code, state },
              timeout: 30000,
            });
            const cj = cb.json;
            diskLog(`callback 交换: HTTP ${cb.status} success=${cj?.success} user=${cj?.userName ?? ""}`);
            if (cb.status === 200 && cj?.success) {
              // 会话已落盘, 重读本机最新凭据
              let fresh = cookie;
              try {
                fresh = discoverSession({ force: true }).cookie;
              } catch {}
              const v = await validateSession(fresh);
              return okResult({
                key: "auto",
                accountId: cj.userName || v.accountId,
                session: v.session,
                via: "huawei-oauth",
              });
            }
            return {
              type: "failed",
              error: `登录回调失败: HTTP ${cb.status} ${String(cb.body ?? "").slice(0, 200)}`,
            };
          }
          await sleep(POLL_MS());
        }
      } finally {
        diskLog("callback 结束");
      }
    },
  };
}

// 直通入口: 手动给 code -> 直接完成交换(无浏览器场景/测试)
export async function oauthExchangeDirect({ code, state, log } = {}) {
  let cookie = "";
  try {
    cookie = discoverSession().cookie;
  } catch {}
  const client = makeClient(cookie);
  const cb = await client.call("/api/login/callback", {
    method: "POST",
    body: { code, state },
    timeout: 30000,
  });
  const cj = cb.json;
  if (cb.status === 200 && cj?.success) {
    let fresh = cookie;
    try {
      fresh = discoverSession({ force: true }).cookie;
    } catch {}
    const v = await validateSession(fresh);
    return okResult({ key: "auto", accountId: cj.userName || v.accountId, session: v.session, via: "huawei-oauth" });
  }
  return { type: "failed", error: `登录回调失败: HTTP ${cb.status} ${String(cb.body ?? "").slice(0, 200)}` };
}