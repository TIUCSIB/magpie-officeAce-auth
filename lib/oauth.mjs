// OfficeAce 的「oauth 风格」登录方法。
//
// 为什么是「风格」而不是真 OAuth:
//   OfficeAce 的真登录(华为 OAuth2)由桌面端完成, 会话凭据(oc_sid)也由它自己
//   维护和轮换。插件再造一遍 OAuth 客户端(驱动浏览器 + 回调 + token 刷新)
//   又脆又没必要。这里借 magpie 的 oauth 管道把「登录」做成和 OAuth 一致的
//   三步体验:
//
//     1) 本机会话已在 -> 直接 success(相当于 OAuth 的静默刷新, 不弹浏览器)
//     2) 会话不在 -> 起一个 127.0.0.1 回环页:
//          引导「打开 OfficeAce 完成登录后点完成」, 页面把 oc_sid(或 auto)
//          带回 magpie 的 oauth 回调, 插件完成落库
//     3) 任何情况都接受手动粘贴 oc_sid(token 输入兜底)
//
// 附带好处: magpie 对 oauth 类方法会自动持久化 authorize() 返回的 accountId
// (api 类不会 —— 那正是 loader 里要手动 client.auth.set 的原因)。
// 选了这个方法后, 账号名一劳永逸, 不再显示「API key …末四位」。
import http from "node:http";
import { discoverSession, cookieFilePath } from "./cookie.mjs";
import { makeClient } from "./agent.mjs";
import { discoverGateway } from "./gateway.mjs";

// ── oc_sid 编解码(在回环页与回调之间走 URL 安全格式) ──────────────

export function encodeCookie(cookie) {
  return Buffer.from(String(cookie), "utf8").toString("base64url");
}

/** 回调 code -> { kind: "auto" | "cookie", cookie? } */
export function decodeCookie(code) {
  const s = String(code ?? "").trim();
  if (!s) return { kind: "none" };
  if (s === "auto") return { kind: "auto" };
  try {
    const raw = Buffer.from(s, "base64url").toString("utf8");
    // Node 的 base64url 解码是宽容的(非法字符会被忽略), 只有能无损往返的
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

// ── 一次性回环服务器 ────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function homePage({ redirectTarget }) {
  const target = JSON.stringify(redirectTarget || "/done");
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
  .muted{color:#57606a;font-size:12px}
</style></head>
<body>
<h1>OfficeAce 登录授权</h1>
<p id="status" class="muted">检查本机登录态…</p>
<div class="card">
  <div id="autoBox" style="display:none">
    <p>检测到本机已登录<strong id="account"></strong>。点下面的按钮完成授权:</p>
    <button id="go">完成授权 ✓</button>
  </div>
  <div id="manualBox" style="display:none">
    <p>未检测到本机会话。<strong>请先启动 OfficeAce 并在桌面端完成登录</strong>,
    然后回来点下面的按钮:</p>
    <button id="go2">我已登录 OfficeAce, 完成授权 ✓</button>
    <hr>
    <p class="muted">或者手动粘贴 oc_sid(在 <code id="cookieFile"></code> 里, DPAPI 解出
    <code>{"value": …}</code> 的 value):</p>
    <input id="sid" placeholder="oc_sid…" autocomplete="off">
    <p style="margin-top:8px"><button id="paste">用粘贴的 oc_sid 授权</button></p>
  </div>
  <p id="note" class="muted"></p>
</div>
<script>
const REDIRECT = ${target};
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const done = (code) => location.href = REDIRECT + (REDIRECT.includes("?") ? "&" : "?") + "code=" + encodeURIComponent(code);
(async () => {
  let s = {};
  try { s = await (await fetch("/status")).json(); } catch {}
  document.getElementById("note").textContent = s.note || "";
  document.getElementById("cookieFile").textContent = s.file || "";
  if (s.hasSession) {
    document.getElementById("account").textContent = s.account ? "（" + s.account + "）" : "";
    document.getElementById("autoBox").style.display = "";
    document.getElementById("go").onclick = () => done("auto");
  } else {
    document.getElementById("manualBox").style.display = "";
    document.getElementById("go2").onclick = () => done("auto");
    document.getElementById("paste").onclick = () => {
      const v = document.getElementById("sid").value.trim();
      if (v) done(b64u(v));
    };
  }
})();
</script>
</body></html>`;
}

function startLoopback() {
  const server = http.createServer();
  let onCode = null;

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
            note = `本地 API 会话: ${v.session}`;
          } else {
            note = "未检测到本机会话文件(或内容为空)";
          }
        } catch (err) {
          note = String(err?.message ?? err);
        }
        send(
          200,
          JSON.stringify({ hasSession, account, file, note }),
          "application/json; charset=utf-8",
        );
        return;
      }

      if (u.pathname === "/done") {
        const code = u.searchParams.get("code") ?? "";
        if (onCode) onCode(code);
        send(200, `<!doctype html><meta charset="utf-8"><title>完成</title>
          <body style="font:14px system-ui;margin:48px auto;max-width:480px">
          <h2>授权已提交 ✓</h2><p>如果 magpie 没有自动继续, 请手动粘贴 oc_sid 再试。</p></body>`);
        return;
      }

      send(200, homePage({ redirectTarget: null }));
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
        set onCode(fn) {
          onCode = fn;
        },
      });
    });
  });
}

// ── oauth authorize 主流程 ──────────────────────────────────────────

/**
 * magpie oauth 方法的 authorize。
 * inputs: { token?, key?, callback? }
 *   token/key  手动给的 oc_sid(或 "auto")
 *   callback   magpie 给的回调地址(可选; 页面会把 code 带回去)
 */
export async function oauthAuthorize(inputs = {}) {
  const given = String(inputs?.token ?? inputs?.key ?? "").trim();

  // 1) 手动 token: 验证并直接落库
  if (given && given !== "auto") {
    const v = await validateSession(given);
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
    const { cookie } = discoverSession({ force: true });
    if (cookie) {
      const v = await validateSession(cookie);
      return okResult({ key: "auto", accountId: v.accountId, session: v.session, via: "local-session" });
    }
  } catch {
    // 没有会话文件 -> 走浏览器回环
  }

  // 3) 浏览器回环: 引导「打开 OfficeAce 登录后点完成」
  const server = await startLoopback();
  const redirectTarget =
    typeof inputs?.callback === "string" && /^https?:\/\//i.test(inputs.callback)
      ? inputs.callback
      : null;
  // 宿主没有回调管道时, 页面会落在我们自己的 /done 上; 这里的 promise 兜住它
  const waitForCode = new Promise((resolve) => {
    server.onCode = resolve;
  });
  // 兜底: 用户关掉页面/宿主不回调时, 别让回环端口一直占着
  const guard = setTimeout(() => server.close(), 10 * 60 * 1000);

  return {
    type: "browser",
    url: server.url,
    callback: async (code) => {
      try {
        const got = String(code ?? "").trim() || (await waitForCode);
        const dec = decodeCookie(got);

        if (dec.kind === "auto" || !dec.cookie) {
          let cookie = "";
          try {
            cookie = discoverSession({ force: true }).cookie;
          } catch (err) {
            return {
              type: "failed",
              error: `没读到本机会话。请先启动 OfficeAce 并登录: ${err?.message ?? err}`,
            };
          }
          if (!cookie) {
            return {
              type: "failed",
              error: "没读到本机会话。请先启动 OfficeAce 并登录, 或改用手动粘贴 oc_sid。",
            };
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
        clearTimeout(guard);
        setTimeout(() => server.close(), 1000);
      }
    },
  };
}