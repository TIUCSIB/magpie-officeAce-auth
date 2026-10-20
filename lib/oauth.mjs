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
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { appendFileSync } from "node:fs";

const CLAW_BASE = process.env.MAGPIE_OFFICEACE_CLOUD_ORIGIN || "https://agentarts.cn-southwest-2.myhuaweicloud.com";
const AUTH_BASE = "https://auth.huaweicloud.com";
const IAM_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const CLIENT_ID = process.env.MAGPIE_OFFICEACE_OAUTH_CLIENT_ID || "pdp5_for_agentarts";
const REGION = process.env.MAGPIE_OFFICEACE_REGION || "cn-southwest-2";

const POLL_MS = () => Math.max(800, Number(process.env.MAGPIE_OFFICEACE_OAUTH_POLL_MS || 2000));
const POLL_TIMEOUT_MS = () => Number(process.env.MAGPIE_OFFICEACE_OAUTH_TIMEOUT_MS || 300000);
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
  return {
    accessToken: typeof raw.access_token === "string" ? raw.access_token : "",
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : "",
    expiresAt: Number(c.expiration) || (expiresIn ? Date.now() + expiresIn * 1000 : 0),
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

// ── oauth authorize 主流程 ──────────────────────────────────────────

export async function oauthAuthorize(inputs = {}, { log } = {}) {
  diskLog(`authorize 开始(纯云端) inputs=${JSON.stringify(Object.keys(inputs ?? {}))}`);
  let state;
  try {
    state = await createState();
  } catch (err) {
    diskLog(`state 失败: ${err?.message ?? err}`);
    return { type: "failed", error: `发起华为云登录失败: ${err?.message ?? err}` };
  }
  const { codeVerifier, codeChallenge } = generatePkce();
  const { privateJwk, publicJwk } = await generateDpopKeyPair();
  const url = buildAuthorizeUrl(state, codeChallenge);
  diskLog(`authorizeUrl=${url.slice(0, 120)}… state=${state.slice(0, 8)}…`);
  log?.info?.(`华为云登录页: ${url}`);

  return {
    url,
    instructions: "请在打开的华为云登录页完成登录; 授权后将自动完成。",
    method: "auto",
    opened: false,
    callback: async () => {
      try {
        // 1) 轮询授权码
        const deadline = Date.now() + POLL_TIMEOUT_MS();
        let code = "";
        for (;;) {
          if (Date.now() > deadline) {
            diskLog("callback 轮询超时");
            return { type: "failed", error: `等待华为云授权超时(${Math.round(POLL_TIMEOUT_MS() / 1000)}s)。请重试。` };
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

        // 2) DPoP 换 token
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
        diskLog(`token 交换: HTTP ${tr.status} hasAccess=${typeof tr.json?.access_token === "string"}`);
        if (tr.status !== 200 || !tr.json?.access_token) {
          return { type: "failed", error: `IAM token 交换失败: HTTP ${tr.status} ${String(tr.body).slice(0, 200)}` };
        }
        const n = normalizeTokenResponse(tr.json);

        // 3) 组装 magpie oauth 成功结果(带 IAM 凭据供运行时直连)
        const accountName = accountNameFromIdToken(n.idToken) || n.projectId;
        diskLog(`成功: accountId=${accountName || "?"} expires=${n.expiresAt ? new Date(n.expiresAt).toISOString() : "0"} project=${n.projectId.slice(0, 6)}…`);
        return {
          type: "success",
          access: n.accessToken,
          ...(n.refreshToken ? { refresh: n.refreshToken } : {}),
          ...(n.expiresAt ? { expires: n.expiresAt } : {}),
          accountId: accountName || CLIENT_ID,
          metadata: {
            provider: "huawei-oauth",
            region: REGION,
            iamAccessKey: n.accessKey,
            iamSecretKey: n.secretKey,
            iamSecurityToken: n.securityToken,
            iamProjectId: n.projectId,
            dpopPrivateJwk: privateJwk,
            dpopPublicJwk: publicJwk,
          },
        };
      } catch (err) {
        diskLog(`callback 异常: ${err?.message ?? err}`);
        return { type: "failed", error: `登录异常: ${err?.message ?? err}` };
      }
    },
  };
}

/** 用 refresh_token 换新凭据(magpie auth.refresh 钩子用) */
export async function oauthRefresh(auth) {
  const dpop = auth?.metadata?.dpopPrivateJwk ? auth.metadata : null;
  const refreshToken = auth?.refresh ?? "";
  if (!dpop || !refreshToken) throw new Error("无 refresh 凭据");
  const privateKey = await importDpopPrivateKey(dpop.dpopPrivateJwk);
  const dpopJwt = await generateDpopJwt(privateKey, dpop.dpopPublicJwk, "POST", IAM_TOKEN_URL);
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const tr = await postToken(form, dpopJwt);
  if (tr.status !== 200 || !tr.json?.access_token) {
    const e = new Error(`刷新失败: HTTP ${tr.status} ${String(tr.body).slice(0, 160)}`);
    e.signIn = "expired";
    throw e;
  }
  const n = normalizeTokenResponse(tr.json);
  return {
    access: n.accessToken,
    refresh: n.refreshToken || refreshToken,
    expires: n.expiresAt || Date.now() + 3600_000,
    accountId: auth.accountId,
    metadata: {
      ...auth.metadata,
      iamAccessKey: n.accessKey,
      iamSecretKey: n.secretKey,
      iamSecurityToken: n.securityToken,
      iamProjectId: n.projectId,
    },
  };
}