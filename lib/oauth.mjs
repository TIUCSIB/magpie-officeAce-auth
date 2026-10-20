// OfficeAce 的「oauth 风格」登录方法 — v3
//
// 契约(对照 @magpie-community/opencode-workbuddy-auth 同款外部插件验证过):
//   magpie 的 oauth 后端**不认 authorize 直接返回 success** —— 它把任何返回值
//   都存进 session, 完成只能靠之后调用结果对象上的 callback()。
//   所以:
//     authorize() 永远返回 { url, method: "auto", instructions, callback }
//     callback()   才是真正的收尾: 探测本机会话/等回环页信号 -> success|failed
//
// 历史教训:
//   v1 在 authorize 里 fast path 返回 success        -> magpie 挂起, 某刻调
//      s.a.callback() 撞上 undefined: "s.a.callback is not a function"
//   v2 阻塞式 authorize 返回 success                 -> magpie 同样不落库(挂起)
//   v3(=本版): success 永远只从 callback 里回来, 契约为王。
//
// 完成方式(用户视角 = WorkBuddy 一样):
//   magpie 用系统浏览器打开我们的 127.0.0.1 回环页; 页面每秒探测本机会话文件,
//   出现即自动完成; 也可在页面粘贴 oc_sid。callback 被 magpie 调用时:
//     1) 先快速看本机会话(等效 OAuth 静默刷新) -> 有就直接 success, 用户无感知
//     2) 没有 -> 等回环页信号(用户登录 OfficeAce 或粘贴 oc_sid)
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { discoverSession, cookieFilePath } from "./cookie.mjs";
import { makeClient } from "./agent.mjs";
import { discoverGateway } from "./gateway.mjs";

const WAIT_MS = Number(process.env.MAGPIE_OFFICEACE_OAUTH_TIMEOUT_MS || 180000);
const PULSE_MS = 1000;

// 磁盘日志: magpie GUI 里看不到插件日志, 关键步骤追加到 %TEMP%\magpie-officeace-oauth.log
const LOG_FILE = join(tmpdir(), "magpie-officeace-oauth.log");
function diskLog(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ── oc_sid 编解码(回环页 <-> callback 之间走 URL 安全格式) ──────────

export function encodeCookie(cookie) {
  return Buffer.from(String(cookie), "utf8").toString("base64url");
}

/** code -> { kind: "auto" | "cookie", cookie? } */
export function decodeCookie(code) {
  const s = String(code ?? "").trim();
  if (!s) return { kind: "none" };
  if (s === "auto") return { kind: "auto" };
  try {
    const raw = Buffer.from(s, "base64url").toString("utf8");
    // Node 的 base64url 解码是宽容的(非法字符被忽略), 只有能无损往返的
    // 才算真编码; 否则按明文 cookie 处理(直接粘了 oc_sid 也认)。
    if (raw && Buffer.from(raw, "utf8").toString("base64url") === s) {
      return { kind: "cookie", cookie: raw };
    }
  } catch {}
  return { kind: "cookie", cookie: s };
}

// ── 会话验证 ────────────────────────────────────────────────────────

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
    // App 没开 / 连不上本地 API —— 直连链路不依赖它, 只是拿不到账号名
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

// ── 回环服务器 ──────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function homePage() {
  const pulse = JSON.stringify(PULSE_MS);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>OfficeAce 登录授权</title>
<style>
  body{font:14px/1.7 system-ui,sans-serif;max-width:560px;margin:48px auto;color:#1f2328;padding:0 16px}
  h1{font-size:20px} code{background:#f6f8fa;padding:1px 6px;border-radius:4px}
  .card{border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:16px 0}
  button{background:#1f883d;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer}
  button:disabled{background:#94d3a2;cursor:not-allowed}
  input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #d0d7de;border-radius:6px;font-family:ui-monospace,monospace}
  .muted{color:#57606a;font-size:12px} .ok{color:#1a7f37}
</style></head>
<body>
<h1>OfficeAce 登录授权</h1>
<p class="muted">本页由 magpie 插件在本机打开。检测到本机会话后会自动完成，可关闭本页。</p>
<div class="card">
  <p id="status" class="muted">检查本机登录态…</p>
  <div id="autoBox" style="display:none">
    <p>检测到本机已登录<strong id="account"></strong>。正在完成…</p>
    <button id="go" disabled>完成授权 ✓</button>
  </div>
  <div id="manualBox" style="display:none">
    <p><strong>请先启动 OfficeAce 并在桌面端完成登录</strong>, 本页会自动继续;
    也可以手动粘贴 oc_sid(<code id="cookieFile"></code> 里 DPAPI 解出的
    <code>{"value": …}</code>):</p>
    <input id="sid" placeholder="oc_sid…" autocomplete="off">
    <p style="margin-top:8px"><button id="paste">用粘贴的 oc_sid 完成</button></p>
  </div>
  <p id="note" class="muted"></p>
</div>
<script>
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
function finish(code) { location.href = "/done?code=" + encodeURIComponent(code); }
async function refresh() {
  let s = {};
  try { s = await (await fetch("/status")).json(); } catch {}
  document.getElementById("note").textContent = s.note || "";
  document.getElementById("cookieFile").textContent = s.file || "";
  if (s.hasSession) {
    document.getElementById("account").textContent = s.account ? "（" + s.account + "）" : "";
    document.getElementById("autoBox").style.display = "";
    document.getElementById("go").disabled = false;
    document.getElementById("go").onclick = () => finish("auto");
  } else {
    document.getElementById("manualBox").style.display = "";
    document.getElementById("paste").onclick = () => {
      const v = document.getElementById("sid").value.trim();
      if (v) finish(b64u(v));
    };
  }
}
refresh();
setInterval(refresh, ${pulse});
</script>
</body></html>`;
}

function startLoopback() {
  const server = http.createServer();
  let doneSettled = null;
  let resolveDone = null;
  const donePromise = new Promise((res) => {
    resolveDone = res;
  });

  server.on("request", async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, body, ctype = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": ctype, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (u.pathname === "/status") {
        let hasSession = false;
        let account = "";
        let note = "";
        let file = "";
        try {
          file = cookieFilePath();
          const { cookie } = discoverSession({ force: true });
          hasSession = Boolean(cookie);
          if (hasSession) {
            const v = await Promise.race([
              validateSession(cookie),
              new Promise((r) => setTimeout(() => r({ accountId: "", session: "timeout" }), 2500)),
            ]);
            account = v.accountId;
            note = `本机会话: ${v.session}`;
          } else {
            note = "未检测到本机会话 —— 请打开 OfficeAce 登录, 本页会自动继续";
          }
        } catch (err) {
          note = String(err?.message ?? err);
        }
        send(200, JSON.stringify({ hasSession, account, file, note }), "application/json; charset=utf-8");
        return;
      }

      if (u.pathname === "/done") {
        const code = u.searchParams.get("code") ?? "";
        resolveDone(code);
        send(200, `<!doctype html><meta charset="utf-8"><title>完成</title>
          <body style="font:14px system-ui;margin:48px auto;max-width:480px">
          <h2>授权已提交 ✓</h2><p>可以关闭本页了。</p></body>`);
        return;
      }

      send(200, homePage());
    } catch (err) {
      send(500, String(err?.message ?? err));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
        get donePromise() {
          return donePromise;
        },
      });
    });
  });
}

// ── 收尾(callback): 先看本机会话(静默刷新), 再等回环页信号 ──────────

async function settleCookie(cookie, via) {
  const v = await validateSession(cookie);
  return okResult({ key: cookie, accountId: v.accountId, session: v.session, via });
}

async function settleAuto(via) {
  let cookie = "";
  try {
    cookie = discoverSession({ force: true }).cookie;
  } catch (err) {
    diskLog(`settleAuto 本机会话读取失败: ${err?.message ?? err}`);
    return { type: "failed", error: `没读到本机会话: ${err?.message ?? err}` };
  }
  if (!cookie) {
    return { type: "failed", error: "没读到本机会话。请先启动 OfficeAce 并登录, 或改用手动粘贴 oc_sid。" };
  }
  const v = await validateSession(cookie);
  if (v.session === "not-logged-in") {
    return { type: "failed", error: "本机会话已失效, 请重新登录 OfficeAce" };
  }
  return okResult({ key: "auto", accountId: v.accountId, session: v.session, via });
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * oauth 方法 authorize —— **永远返回浏览器结果, 不返回 success**。
 * magpie 打开了 url 后会在适当时机调用返回对象上的 callback(), 收尾在里面。
 */
export async function oauthAuthorize(inputs = {}, { log } = {}) {
  const given = String(inputs?.token ?? inputs?.key ?? "").trim();
  const server = await startLoopback();
  const url = server.url;
  const marker = join(tmpdir(), "officeace-oauth-url.txt");
  try {
    writeFileSync(marker, url);
  } catch {}
  log?.info?.(`OfficeAce 登录页: ${url} (也已写入 ${marker})`);
  diskLog(`authorize 开始 inputs=${JSON.stringify(Object.keys(inputs ?? {}))} url=${url} marker=${marker}`);

  return {
    url,
    instructions: "请在浏览器打开的页面中完成 OfficeAce 登录; 检测到本机会话后会自动完成。",
    method: "auto",
    opened: false,
    callback: async () => {
      try {
        // 1) 手动给的 oc_sid(若有): 直接用
        if (given && given !== "auto") {
          const v = await validateSession(given);
          diskLog(`callback token 路径 session=${v.session}`);
          if (v.session === "not-logged-in") {
            return { type: "failed", error: "这个 oc_sid 不是有效登录态。请重新登录 OfficeAce 后拿新的。" };
          }
          return okResult({ key: given, accountId: v.accountId, session: v.session, via: "token" });
        }

        // 2) 本机会话已在: 秒成功(等效 OAuth 静默刷新, 用户无感知)
        try {
          const { cookie, source } = discoverSession({ force: true });
          diskLog(`callback 本机会话: source=${source} cookie=${cookie ? cookie.length + "字符" : "无"}`);
          if (cookie) {
            const v = await validateSession(cookie);
            diskLog(`callback fast path: session=${v.session} account=${v.accountId || "?"}`);
            if (v.session !== "not-logged-in") {
              return okResult({ key: "auto", accountId: v.accountId, session: v.session, via: "local-session" });
            }
          }
        } catch (err) {
          diskLog(`callback 本机会话读取失败: ${err?.message ?? err}`);
        }

        // 3) 等回环页: 用户登录 OfficeAce 或粘贴 oc_sid
        diskLog("callback 等待回环页信号…");
        const code = await Promise.race([
          server.donePromise,
          new Promise((r) => setTimeout(() => r("__timeout__"), WAIT_MS)),
        ]);
        if (code === "__timeout__") {
          diskLog("callback 等待超时");
          return {
            type: "failed",
            error: `登录等待超时(${Math.round(WAIT_MS / 1000)}s)。浏览器没弹就手动打开: ${url}; 或改用手动粘贴 oc_sid。`,
          };
        }

        const dec = decodeCookie(code);
        diskLog(`回环完成 code=${dec.kind}`);
        if (dec.kind === "auto" || !dec.cookie) return settleAuto("browser");
        return settleCookie(dec.cookie, "browser");
      } finally {
        setTimeout(() => server.close(), 300);
      }
    },
  };
}

// 供极端无头场景/测试直接驱动: 以 token 直通路径收尾(不走浏览器结果)。
export async function oauthTokenOnly(inputs = {}) {
  const given = String(inputs?.token ?? inputs?.key ?? "").trim();
  if (given && given !== "auto") return settleCookie(given, "token");
  return settleAuto("token");
}