// OfficeAce 本机登录态读取
// 会话保存在 %USERPROFILE%\.office-claw\session.cookie
// 格式: "OC-DPAPI-1" + base64(DPAPI 密文)  ->  JSON {value, expires}
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MAGIC = "OC-DPAPI-1";
const COOKIE_NAME = "oc_sid";

export function cookieFilePath() {
  return (
    process.env.MAGPIE_OFFICEACE_COOKIE_FILE ||
    join(homedir(), ".office-claw", "session.cookie")
  );
}

function dpapiUnprotect(b64) {
  const ps = [
    "Add-Type -AssemblyName System.Security;",
    `$b=[Convert]::FromBase64String('${b64}');`,
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($p));",
  ].join("");
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  ).trim();
  return Buffer.from(out, "base64").toString("utf8");
}

/**
 * 读取本机 OfficeAce 的 oc_sid。
 * 优先级: 环境变量 MAGPIE_OFFICEACE_COOKIE > session.cookie(DPAPI) > 明文 JSON
 *
 * 结果会缓存一小会儿: DPAPI 解密要 spawn 一次 PowerShell(1~2s), 每个请求都解
 * 会把延迟拖到超时。cookie 本身有效期很长, 5 分钟缓存足够。
 */
const CACHE_TTL_MS = Number(process.env.MAGPIE_OFFICEACE_COOKIE_TTL_MS || 300000);
let sessionCache = null; // { at, value }

export function discoverSession({ force = false } = {}) {
  if (!force && sessionCache && Date.now() - sessionCache.at < CACHE_TTL_MS) {
    return sessionCache.value;
  }
  const fresh = readSession();
  sessionCache = { at: Date.now(), value: fresh };
  return fresh;
}

/** cookie 失效时让缓存作废, 下次重新解 */
export function invalidateSession() {
  sessionCache = null;
}

function readSession() {
  const env = process.env.MAGPIE_OFFICEACE_COOKIE?.trim();
  if (env) return { cookie: env, expires: 0, source: "env" };

  const file = cookieFilePath();
  if (!existsSync(file)) {
    throw new Error(
      `找不到 OfficeAce 登录态文件: ${file}。请先在本机登录 OfficeAce,或设置 MAGPIE_OFFICEACE_COOKIE。`,
    );
  }
  const raw = readFileSync(file, "utf8").trim();
  let json;
  if (raw.startsWith(MAGIC)) {
    json = JSON.parse(dpapiUnprotect(raw.slice(MAGIC.length).trim()));
  } else {
    json = JSON.parse(raw);
  }
  const value = json?.value;
  if (!value) throw new Error("OfficeAce 登录态文件内容无法解析(缺少 value)");
  const expires = Number(json?.expires) || 0;
  return {
    cookie: value,
    expires: expires > 1e12 ? expires : Math.round(expires * 1000),
    source: "dpapi",
  };
}

export function cookieHeader(cookie) {
  const v = cookie.includes("=") ? cookie : `${COOKIE_NAME}=${cookie}`;
  return v;
}
