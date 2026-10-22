// OfficeAce 真 OAuth — 纯云端自持版(v5, 完全不依赖 OfficeAce 本地 API)
//
// 流程(逆向 channel-plugins/auth/officeace-huawei-oauth 还原):
//   1) POST {claw}/v1/claw/auth/state            -> {state}   (无 body)
//   2) 本地生成 PKCE(verifier/challenge) + DPoP EC P-256 密钥对(本地持有)
//   3) authorizeUrl = auth.huaweicloud.com/authui/login.html?service=<oauth2/authorize>
//      (client_id=pdp5_for_agentarts, code_challenge, state, scope=openid,
//       redirect_uri={claw}/v1/claw/auth/callback, response_type=code)
//   4) 用户在华为云登录(真 OAuth, 云端回调)
//   5) GET {claw}/v1/claw/auth/code?state=  轮询 -> 202 未就绪 / {code}
//   6) POST {sts}/v1/oauth2/tokens  (form: client_id, code, code_verifier,
//      grant_type=authorization_code, redirect_uri;  header: DPoP ES256 JWT)
//      -> {access_token, credentials:{access_key_id, secret_access_key,
//         security_token, project_id, expiration}, refresh_token, id_token}
//   7) 刷新: 同端点 grant_type=refresh_token + DPoP(同密钥)
//
// magpie 侧: authorize 返回浏览器结果; 成功在 callback 里返回
// {type:"success", access, refresh, expires, accountId, metadata:{IAM 凭据}}
// —— 按 magpie 契约存为 oauth 型账号(带 refresh 可由 auth.refresh 续期)。
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { appendFileSync } from "node:fs";
import { clawRequest } from "./cloud.mjs";

const CLAW_BASE = process.env.MAGPIE_OFFICEACE_CLOUD_ORIGIN || "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const AUTH_BASE = "https://auth.huaweicloud.com";
const IAM_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const CLIENT_ID = process.env.MAGPIE_OFFICEACE_OAUTH_CLIENT_ID || "pdp5_for_agentarts";
const REGION = process.env.MAGPIE_OFFICEACE_REGION || "cn-southwest-2";

const POLL_MS = () => Math.max(800, Number(process.env.MAGPIE_OFFICEACE_OAUTH_POLL_MS || 2000));
// 超时下限 30s: 调试变量若被宿主进程残留(如 test.mjs 的 1500), 真实登录也不该秒超时
const POLL_TIMEOUT_MS = () => Math.max(30_000, Number(process.env.MAGPIE_OFFICEACE_OAUTH_TIMEOUT_MS || 300000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_FILE = joinPath(tmpdir(), "magpie-officeace-oauth.log");
function diskLog(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// ── PKCE / DPoP ─────────────────────────────────────────────────────

function generatePkce() {
  const codeVerifier = b64u(randomBytes(32));
  const codeChallenge = b64u(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

async function generateDpopKeyPair() {
  const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  return { privateJwk, publicJwk };
}

async function importDpopPrivateKey(privateJwk) {
  return webcrypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function generateDpopJwt(privateKey, publicJwk, htm, htu, nowMs = Date.now()) {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } };
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString("hex") };
  const headerB64 = b64u(JSON.stringify(header));
  const payloadB64 = b64u(JSON.stringify(payload));
  const signatureB64 = b64u(
    await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(`${headerB64}.${payloadB64}`)),
  );
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ── state / authorizeUrl ────────────────────────────────────────────

async function createState() {
  const res = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`获取 state 失败: HTTP ${res.status}`);
  const data = await res.json();
  const state = String(data?.state ?? "").trim();
  if (!state) throw new Error("云端未返回 state");
  return state;
}

function buildAuthorizeUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "SHA-256",
    state,
    scope: "openid",
    redirect_uri: `${CLAW_BASE}/v1/claw/auth/callback`,
    response_type: "code",
  });
  const inner = `${AUTH_BASE}/authui/v1/oauth2/authorize?${params.toString()}`;
  return `${AUTH_BASE}/authui/login.html?service=${encodeURIComponent(inner)}`;
}

// ── token 交换/刷新 ─────────────────────────────────────────────────

async function postToken(form, dpopJwt) {
  const res = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", DPoP: dpopJwt },
    body: form.toString(),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, body: text };
}

function normalizeTokenResponse(raw) {
  const c = raw?.credentials ?? {};
  const expiresIn = Number(raw?.expires_in ?? 0);
  // 华为端点 credentials.expiration 是 ISO 时间字符串(如 2026-10-20T07:45:13.289Z),
  // Number() 会得 NaN -> 0, 导致下游"永不过期"误判、凭据过期后不自动刷新。
  const expMs =
    Date.parse(String(c.expiration ?? "")) || (expiresIn ? Date.now() + expiresIn * 1000 : 0);
  return {
    accessToken: typeof raw.access_token === "string" ? raw.access_token : "",
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : "",
    expiresAt: expMs,
    accessKey: String(c.access_key_id ?? ""),
    secretKey: String(c.secret_access_key ?? ""),
    securityToken: String(c.security_token ?? ""),
    projectId: String(c.project_id ?? ""),
    idToken: typeof raw.id_token === "string" ? raw.id_token : "",
  };
}

function accountNameFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return String(payload.preferred_username ?? payload.name ?? "").trim();
  } catch {
    return "";
  }
}

// ── 主流程(拆两段, 供 oauth 方法承载: magpie 开浏览器 + callback 收尾) ──

/**
 * 第一段: 发起授权 —— state + PKCE + DPoP 密钥 + 登录页 URL。
 * 不轮询、不开浏览器(magpie 的 oauth 方法会打开返回的 url)。
 */
export async function startCloudAuthorize() {
  diskLog("startCloudAuthorize");
  const state = await createState();
  const { codeVerifier, codeChallenge } = generatePkce();
  const { privateJwk, publicJwk } = await generateDpopKeyPair();
  const url = buildAuthorizeUrl(state, codeChallenge);
  diskLog(`authorizeUrl=${url.slice(0, 120)}… state=${state.slice(0, 8)}…`);
  return { state, codeVerifier, privateJwk, publicJwk, url };
}

/**
 * 第二段: 轮询授权码 → DPoP 换 IAM 凭据。
 * 返回 { ok:true, refreshToken, accessToken, expiresAt, accountName, metadata }
 * 或 { ok:false, error }。
 */
export async function finishCloudAuthorize(session) {
  const { state, codeVerifier, privateJwk, publicJwk } = session;
  const deadline = Date.now() + POLL_TIMEOUT_MS();
  let code = "";
  for (;;) {
    if (Date.now() > deadline) {
      diskLog("轮询超时");
      return { ok: false, error: `等待华为云授权超时(${Math.round(POLL_TIMEOUT_MS() / 1000)}s)。请重试。` };
    }
    let r = null;
    try {
      r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
        headers: { Accept: "application/json" },
      });
    } catch {}
    const j = r ? await r.json().catch(() => null) : null;
    code = j && typeof j.code === "string" ? j.code : "";
    if (code) break;
    diskLog(`poll: HTTP ${r?.status ?? 0} ${j?.error_code ?? ""}`);
    await sleep(POLL_MS());
  }

  // DPoP 换 token
  const privateKey = await importDpopPrivateKey(privateJwk);
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, "POST", IAM_TOKEN_URL);
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: `${CLAW_BASE}/v1/claw/auth/callback`,
  });
  const tr = await postToken(form, dpopJwt);
  diskLog(`token 交换: HTTP ${tr.status} hasAK=${Boolean(tr.json?.credentials?.access_key_id)}`);
  const n = normalizeTokenResponse(tr.json);
  if (tr.status !== 200 || !n.accessKey) {
    return { ok: false, error: `IAM token 交换失败: HTTP ${tr.status} ${String(tr.body).slice(0, 200)}` };
  }
  const accountName = accountNameFromIdToken(n.idToken) || n.projectId;
  diskLog(`成功: accountId=${accountName || "?"} project=${n.projectId.slice(0, 6)}…`);

  const metadata = {
    provider: "huawei-oauth",
    region: REGION,
    iamAccessKey: n.accessKey,
    iamSecretKey: n.secretKey,
    iamSecurityToken: n.securityToken,
    iamProjectId: n.projectId,
    oauthRefreshToken: n.refreshToken,
    oauthExpiresAt: n.expiresAt,
    oauthAccessToken: n.accessToken,
    dpopPrivateJwk: privateJwk,
    dpopPublicJwk: publicJwk,
  };

  // 顺手抓模型网关凭据: 订阅接口 model_infos 下发的 app_key/secret 才是
  // 网关用的 Basic 对(实测 IAM AK/SK 打网关 401 AppKey or AppSecret);
  // 失败不阻塞登录, loader 会降级到本机 routing_state。
  try {
    const sub = await clawRequest(
      { ak: n.accessKey, sk: n.secretKey, token: n.securityToken, projectId: n.projectId },
      "GET",
      "/v1/subscription",
      undefined,
    );
    const info = sub.json?.model_infos?.[0];
    const gk = info?.model_auth_info?.model_app_key;
    const gs = info?.model_auth_info?.model_app_secret;
    if (gk && gs) {
      metadata.gatewayAuthorization = `Basic ${Buffer.from(`${gk}:${gs}`).toString("base64")}`;
      if (info.model_api_url_base) {
        metadata.gatewayBase = `https://${String(info.model_api_url_base).replace(/\/+$/, "")}/v2`;
      }
      diskLog("网关凭据已抓取(model_infos)");
    } else {
      diskLog("订阅响应无 model_infos, 网关凭据降级 routing_state");
    }
  } catch (err) {
    diskLog(`抓网关凭据失败(降级 routing_state): ${err?.message ?? err}`);
  }

  return {
    ok: true,
    refreshToken: n.refreshToken,
    accessToken: n.accessToken,
    expiresAt: n.expiresAt,
    accountName,
    metadata,
  };
}

/**
 * 完整云端 OAuth(诊断/工具用): 发起 → 系统浏览器 → 轮询 → 换凭据。
 * magpie 内的登录走 oauth 方法 + start/finish 两段, 不用这个。
 */
export async function runCloudLogin(inputs = {}, { log } = {}) {
  diskLog(`runCloudLogin 开始 inputs=${JSON.stringify(Object.keys(inputs ?? {}))}`);
  const session = await startCloudAuthorize();
  log?.info?.(`华为云登录页: ${session.url}`);
  if (process.env.MAGPIE_OFFICEACE_OAUTH_NO_OPEN !== "1") {
    openInBrowser(session.url);
  }
  const r = await finishCloudAuthorize(session);
  if (!r.ok) return { type: "failed", error: r.error };
  return {
    type: "success",
    key: "oauth-session",
    refresh: r.refreshToken,
    access: r.accessToken,
    expires: r.expiresAt,
    accountId: r.accountName || CLIENT_ID,
    metadata: r.metadata,
  };
}

/** 用 refresh_token 换新凭据(loader 内自动续期用) */
export async function oauthRefreshCredentials(metadata) {
  const dpop = metadata?.dpopPrivateJwk ? metadata : null;
  const refreshToken = metadata?.oauthRefreshToken ?? "";
  if (!dpop || !refreshToken) throw new Error("无 refresh 凭据");
  const privateKey = await importDpopPrivateKey(dpop.dpopPrivateJwk);
  const dpopJwt = await generateDpopJwt(privateKey, dpop.dpopPublicJwk, "POST", IAM_TOKEN_URL);
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const tr = await postToken(form, dpopJwt);
  const n = normalizeTokenResponse(tr.json);
  if (tr.status !== 200 || !n.accessKey) {
    const e = new Error(`刷新失败: HTTP ${tr.status} ${String(tr.body).slice(0, 160)}`);
    e.signIn = "expired";
    throw e;
  }
  return {
    accessToken: n.accessToken,
    refreshToken: n.refreshToken || refreshToken,
    expiresAt: n.expiresAt || Date.now() + 3600_000,
    // 对齐 metadata 键名: 调用方用 {...auth.metadata, ...m} 合并时自动覆盖。
    // 否则华为云一旦轮换 refresh_token, metadata.oauthRefreshToken 会停留在
    // 旧值, 下次刷新用已作废的旧 token 必失败(signIn:"expired" -> "每天要重登")。
    oauthAccessToken: n.accessToken,
    oauthRefreshToken: n.refreshToken || refreshToken,
    oauthExpiresAt: n.expiresAt || Date.now() + 3600_000,
    iamAccessKey: n.accessKey,
    iamSecretKey: n.secretKey,
    iamSecurityToken: n.securityToken,
    iamProjectId: n.projectId,
    dpopPrivateJwk: dpop.dpopPrivateJwk,
    dpopPublicJwk: dpop.dpopPublicJwk,
  };
}

function openInBrowser(url) {
  const win = process.platform === "win32";
  // 实测: explorer.exe <url> 在部分环境只聚焦资源管理器、不开浏览器(登录 202 超时的
  // 常见原因); cmd /c start "" 走默认浏览器最可靠, 放首位。
  const cmds = win
    ? [["cmd", ["/c", "start", "", url]], ["explorer.exe", [url]], ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]]
    : process.platform === "darwin"
      ? [["open", [url]]]
      : [["xdg-open", [url]]];
  for (const [cmd, args] of cmds) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.unref();
      diskLog(`openInBrowser: ${cmd} -> ok`);
      return true;
    } catch (err) {
      diskLog(`openInBrowser: ${cmd} -> ${err?.message ?? err}`);
    }
  }
  return false;
}

// ── 兼容旧导出(magpie oauth 契约路径, 保留备用) ─────────────────────

export async function oauthAuthorize(inputs = {}, { log } = {}) {
  // magpie oauth 后端把 authorize 结果序列化存储(函数丢失) —— 已证实不可靠。
  // 这里改为阻塞式: 直接复用 api 方法的阻塞流, 返回成功时 magpie 落库。
  return runCloudLogin(inputs, { log });
}

export async function oauthRefresh(auth) {
  const m = await oauthRefreshCredentials(auth?.metadata ?? {});
  return {
    access: m.accessToken,
    refresh: m.refreshToken,
    expires: m.expiresAt,
    accountId: auth?.accountId,
    metadata: { ...auth.metadata, ...m },
  };
}