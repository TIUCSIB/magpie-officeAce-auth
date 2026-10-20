// OfficeAce 的「oauth 风格」登录方法。
//
// 为什么不让 magpie 用自带的浏览器回调:
//   实测本版 magpie(桌面端)对外部插件 authorize() 返回的「浏览器结果」有问题 ——
//   它的 callback 在落库/回传时丢失, 完成阶段直接报
//   "s.a.callback is not a function"。内置插件和宿主同进程所以没事,
//   外部插件(如本插件)必炸。界面表现就是: 显示「已打开登录页」、浏览器没动静、
//   然后弹「登录未完成」。
//
// 所以这里把整条交互塞进 authorize() 内部完成, 返回值只有 success/failed:
//   1) 本机会话在 -> 秒成功(不弹浏览器, 等于 OAuth 的静默刷新)
//   2) 会话不在 -> 起 127.0.0.1 回环页, 插件自己打开浏览器
//      (同时把链接写进临时文件 + 打日志, 浏览器没弹也能手动开):
//        · 页面每秒探测本机会话文件, 一出现就自动完成(先登录 OfficeAce 即可)
//        · 也可以直接在页面上粘贴 oc_sid
//   3) 完成后 authorize 返回 success, magpie 正常落库
//
// 附带好处不变: magpie 对 oauth 类方法自动持久化 accountId, 账号名一劳永逸。
import http from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";
import { discoverSession, cookieFilePath } from "./cookie.mjs";
import { makeClient } from "./agent.mjs";
import { discoverGateway } from "./gateway.mjs";

const OAUTH_TIMEOUT_MS = Number(process.env.MAGPIE_OFFICEACE_OAUTH_TIMEOUT_MS || 120000);
const NO_OPEN = process.env.MAGPIE_OFFICEACE_OAUTH_NO_OPEN === "1";
const PULSE_MS = 1000;

// 磁盘日志: magpie GUI 里看不到插件 log.info/warn, 这里把所有关键步骤追加到
// %TEMP%\magpie-officeace-oauth.log, 出问题直接把文件发出来就能定位。
const LOG_FILE = join(tmpdir(), "magpie-officeace-oauth.log");
function diskLog(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ── oc_sid 编解码(回环页 <-> authorize 之间走 URL 安全格式) ──────────

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

function homePage(serverUrl) {
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
<p class="muted">本页由 magpie 插件在本机打开。完成后本页会自动关闭。</p>
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
async function refresh() {
  let s = {};
  try { s = await (await fetch("/status")).json(); } catch {}
  document.getElementById("note").textContent = s.note || "";
  document.getElementById("cookieFile").textContent = s.file || "";
  if (s.auto) { location.href = "/done?code=auto"; return; }
  if (s.hasSession) {
    document.getElementById("account").textContent = s.account ? "（" + s.account + "）" : "";
    document.getElementById("autoBox").style.display = "";
    document.getElementById("go").disabled = false;
    document.getElementById("go").onclick = () => location.href = "/done?code=auto";
  } else {
    document.getElementById("manualBox").style.display = "";
    document.getElementById("paste").onclick = () => {
      const v = document.getElementById("sid").value.trim();
      if (v) location.href = "/done?code=" + encodeURIComponent(b64u(v));
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
  let onDone = null;

  server.on("request", async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, body, ctype = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": ctype, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (u.pathname === "/status") {
        let hasSession = false;
        let auto = false;
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
            // App 在跑且已登录 -> 直接自动完成; App 没开(无法验证)也完成,
            // 插件拿到 auto 后会再读一次会话落库
            auto = v.session === "ok" || v.session === "local-api-unreachable";
          } else {
            note = "未检测到本机会话 —— 请打开 OfficeAce 登录, 本页会自动继续";
          }
        } catch (err) {
          note = String(err?.message ?? err);
        }
        send(200, JSON.stringify({ hasSession, auto, account, file, note }), "application/json; charset=utf-8");
        return;
      }

      if (u.pathname === "/done") {
        const code = u.searchParams.get("code") ?? "";
        if (onDone) onDone(code);
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
        set onDone(fn) {
          onDone = fn;
        },
      });
    });
  });
}

// ── 打开浏览器 ──────────────────────────────────────────────────────

function openInBrowser(url) {
  const attempts =
    process.platform === "win32"
      ? [
          ["explorer.exe", [url]],
          ["rundll32.exe", ["url.dll,FileProtocolHandler", url]],
          ["cmd", ["/c", "start", "", url]],
        ]
      : process.platform === "darwin"
        ? [["open", [url]]]
        : [["xdg-open", [url]]];
  for (const [cmd, args] of attempts) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.unref();
      diskLog(`openInBrowser: ${cmd} -> ok`);
      return { ok: true, via: cmd };
    } catch (err) {
      diskLog(`openInBrowser: ${cmd} -> ${err?.message ?? err}`);
    }
  }
  return { ok: false, via: "" };
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * oauth 方法的 authorize。只返回 {type:"success"|"failed"},
 * 不返回浏览器结果 —— 见文件头部的说明(外部插件的浏览器回调在 magpie 里会丢)。
 * inputs: { token?, key? }   手动 oc_sid(或 "auto")
 */
export async function oauthAuthorize(inputs = {}, { log } = {}) {
  const given = String(inputs?.token ?? inputs?.key ?? "").trim();
  diskLog(`authorize 开始 inputs=${JSON.stringify(Object.keys(inputs ?? {}))} env.TEMP=${tmpdir()}`);

  // 1) 手动 token: 验证并直接落库
  if (given && given !== "auto") {
    const v = await validateSession(given);
    diskLog(`token 路径: session=${v.session}`);
    if (v.session === "not-logged-in") {
      return {
        type: "failed",
        error: "这个 oc_sid 不是有效登录态。请重新登录 OfficeAce 后拿新的, 或直接粘 auto 用本机会话。",
      };
    }
    return okResult({ key: given, accountId: v.accountId, session: v.session, via: "token" });
  }

  // 2) 本机会话已在: 秒成功, 不弹浏览器
  try {
    const { cookie, source } = discoverSession({ force: true });
    diskLog(`本机会话读取: ${source} cookie=${cookie ? cookie.length + "字符" : "无"}`);
    if (cookie) {
      const v = await validateSession(cookie);
      diskLog(`fast path: session=${v.session} account=${v.accountId || "?"}`);
      if (v.session !== "not-logged-in") {
        return okResult({ key: "auto", accountId: v.accountId, session: v.session, via: "local-session" });
      }
    }
  } catch (err) {
    diskLog(`本机会话读取失败: ${err?.message ?? err}`);
    log?.warn?.(`本机会话读取失败, 转入浏览器流程: ${err?.message ?? err}`);
  }

  // 3) 阻塞式回环流程: 页面自动探测会话 / 手动粘贴 oc_sid
  const server = await startLoopback();
  const url = server.url;
  const marker = join(tmpdir(), "officeace-oauth-url.txt");
  try {
    writeFileSync(marker, url);
  } catch {}
  log?.info?.(`OfficeAce 登录页: ${url} (也已写入 ${marker})`);
  diskLog(`回环页: ${url} (marker=${marker})`);
  const opened = NO_OPEN ? { ok: false } : openInBrowser(url);
  if (!opened.ok) {
    diskLog("未自动打开浏览器");
    log?.warn?.(`未自动打开浏览器(无头模式或打开失败), 请手动打开: ${url}`);
  }

  try {
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("__timeout__"), OAUTH_TIMEOUT_MS);
      server.onDone = (c) => {
        clearTimeout(t);
        resolve(c);
      };
    });

    if (code === "__timeout__") {
      diskLog("回环等待超时");
      return {
        type: "failed",
        error: `登录等待超时(${Math.round(OAUTH_TIMEOUT_MS / 1000)}s)。浏览器没弹就手动打开: ${url}; 或直接在登录框粘贴 oc_sid。`,
      };
    }

    const dec = decodeCookie(code);
    diskLog(`回环完成 code=${dec.kind}`);
    if (dec.kind === "auto" || !dec.cookie) {
      let cookie = "";
      try {
        cookie = discoverSession({ force: true }).cookie;
      } catch (err) {
        return { type: "failed", error: `没读到本机会话: ${err?.message ?? err}` };
      }
      if (!cookie) {
        return { type: "failed", error: "没读到本机会话。请先启动 OfficeAce 并登录, 或改用手动粘贴 oc_sid。" };
      }
      const v = await validateSession(cookie);
      return okResult({ key: "auto", accountId: v.accountId, session: v.session, via: "browser" });
    }

    const v = await validateSession(dec.cookie);
    if (v.session === "not-logged-in") {
      return { type: "failed", error: "这个 oc_sid 不是有效登录态" };
    }
    return okResult({ key: dec.cookie, accountId: v.accountId, session: v.session, via: "browser" });
  } finally {
    setTimeout(() => server.close(), 300);
  }
}