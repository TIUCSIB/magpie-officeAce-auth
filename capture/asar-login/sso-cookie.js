ict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSsoCookieHeader = getSsoCookieHeader;
const electron_1 = require("electron");
const ipc_router_1 = require("./ipc-router");
const logging_1 = require("./logging");
/**
 * SSO Cookie 读取（自定义 MCP 连接器 Cookie 头自动填充，PC 端专用）。
 *
 * 背景：/api/auth/session-cookie 回显的是"发往本地 API 的 Cookie 头"，在
 * 127.0.0.1 源上只含本地会话 cookie（oc_sid），结构上不可能包含 SSO 域下发的
 * huawei_sso。PC 端要拿 SSO 凭证，必须从 Electron 主进程的 WebView cookie
 * jar（defaultSession，与登录页共享分区）读取。
 *
 * 安全约定：cookie 值只经 IPC 返回给本地 renderer，绝不写入日志。
 */
const LOG_TAG = 'sso-cookie';
function normalizedDomain(domain) {
    return domain.replace(/^\./, '').toLowerCase();
}
/** 同域判定：去前导点后相等，或互为子域（login.huawei.com ↔ .huawei.com）。 */
function isSameSite(a, b) {
    const na = normalizedDomain(a);
    const nb = normalizedDomain(b);
    return na === nb || na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`);
}
/**
 * 从 defaultSession cookie jar 中读取目标 SSO cookie，并返回其所在域的
 * 完整 Cookie 头（同域 cookie 按 name 排序拼接，保证输出确定性）。
 *
 * @throws IpcError('SSO_COOKIE_NOT_FOUND') jar 中没有目标 cookie 时抛出
 *         （用户尚未在应用内建立过 SSO 登录态）。
 */
async function getSsoCookieHeader(cookieName) {
    const jar = electron_1.session.defaultSession.cookies;
    const all = await jar.get({ name: cookieName });
    const target = all[0];
    if (!target || !target.domain) {
        (0, logging_1.appendLog)(`[sso-cookie] cookie "${cookieName}" not found in session jar`, 'INFO', LOG_TAG);
        throw new ipc_router_1.IpcError('SSO_COOKIE_NOT_FOUND', `会话中不存在 ${cookieName} Cookie，请先在应用内完成 SSO 登录`);
    }
    const candidates = await jar.get({});
    const targetDomain = target.domain;
    const sameSite = candidates
        .filter((c) => c.domain !== undefined && isSameSite(c.domain, targetDomain))
        // 按 name 字节序排序，保证输出确定且与 locale 无关
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    (0, logging_1.appendLog)(`[sso-cookie] cookie "${cookieName}" found (domain=${targetDomain}), serializing ${sameSite.length} same-site cookie(s)`, 'INFO', LOG_TAG);
    return {
        value: sameSite.map((c) => `${c.name}=${c.value}`).join('; '),
        domain: targetDomain,
        cookieCount: sameSite.length,
    };
}
//# sourceMappingURL=sso-cookie.js.map{"versio