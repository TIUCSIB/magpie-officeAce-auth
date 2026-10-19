// OfficeAce 本机 API 客户端 (https://127.0.0.1:3004, 自签证书)
import https from "node:https";
import { cookieHeader } from "./cookie.mjs";

export const DEFAULT_BASE = process.env.MAGPIE_OFFICEACE_BASE || "https://127.0.0.1:3004";

function request(base, path, { method = "GET", cookie, body, timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      Accept: "application/json",
      Cookie: cookieHeader(cookie || ""),
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const req = https.request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false,
        servername: undefined,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json;
          try {
            json = buf ? JSON.parse(buf) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, body: buf, json });
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`OfficeAce 请求超时: ${method} ${path}`)));
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

export class OfficeAceClient {
  constructor({ cookie, base = DEFAULT_BASE }) {
    this.cookie = cookie;
    this.base = base.replace(/\/+$/, "");
  }

  call(path, opts = {}) {
    return request(this.base, path, { ...opts, cookie: this.cookie });
  }

  async isLogin() {
    const r = await this.call("/api/islogin");
    return { status: r.status, data: r.json };
  }

  async listAgents() {
    const r = await this.call("/api/agents");
    if (r.status !== 200 || !r.json?.agents) {
      throw new Error(`读取 OfficeAce 智能体失败: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    }
    return r.json.agents;
  }

  /** OfficeAce 自己那份可用模型清单(glm-5.2 / deepseek-v4.1-flash ...) */
  async listModels() {
    const r = await this.call("/api/maas-models");
    if (r.status !== 200 || !Array.isArray(r.json?.list)) {
      throw new Error(`读取 OfficeAce 模型清单失败: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    }
    return r.json.list.filter((m) => m?.enabled !== false && m?.model);
  }

  async createThread(title = "magpie", opts = {}) {
    const body = { title };
    if (opts.preferredModel) {
      body.preferredModel = opts.preferredModel;
      body.preferredModelAccountRef = opts.preferredModelAccountRef || "huawei-maas";
    }
    const r = await this.call("/api/threads", { method: "POST", body });
    const thread = r.json?.thread ?? r.json;
    if (r.status < 200 || r.status >= 300 || !thread?.id) {
      throw new Error(`创建 OfficeAce 会话失败: HTTP ${r.status} ${r.body.slice(0, 300)}`);
    }
    return thread;
  }

  async deleteThread(threadId) {
    return this.call(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  }

  async sendMessage({ threadId, content, agentId, signal }) {
    const r = await this.call("/api/messages", {
      method: "POST",
      body: {
        content,
        threadId,
        mentions: agentId ? [agentId] : undefined,
        deliveryMode: "immediate",
      },
      timeout: 60000,
      signal,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`发送 OfficeAce 消息失败: HTTP ${r.status} ${r.body.slice(0, 300)}`);
    }
    return r.json;
  }

  async listMessages(threadId, limit = 60) {
    const r = await this.call(
      `/api/messages?threadId=${encodeURIComponent(threadId)}&limit=${limit}`,
    );
    if (r.status !== 200) {
      throw new Error(`读取 OfficeAce 消息失败: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    }
    return r.json?.messages ?? [];
  }
}
