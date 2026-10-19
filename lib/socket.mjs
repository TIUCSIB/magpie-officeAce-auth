// OfficeAce 实时帧客户端 (socket.io v5 / Engine.IO v4 over WebSocket)
// 这是拿到"逐字流"的唯一途径: REST 的草稿消息在收尾前 content 恒为空。
import { cookieHeader } from "./cookie.mjs";

const EIO_PATH = "/socket.io/?EIO=4&transport=websocket";

function wsUrl(base) {
  return base.replace(/^http/, "ws") + EIO_PATH;
}

/**
 * 打开一条到 OfficeAce 的 socket.io 连接。
 * 返回 { send, close, onEvent }
 */
export async function openSocket({ base, cookie, timeout = 15000 }) {
  const url = wsUrl(base);
  const headers = { Cookie: cookieHeader(cookie) };

  // Bun 支持构造参数里的 headers/tls; Node 的 undici WebSocket 不吃这些, 退化为环境变量
  const supportsOptions = typeof Bun !== "undefined";
  if (!supportsOptions && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const ws = supportsOptions
    ? new WebSocket(url, { headers, tls: { rejectUnauthorized: false } })
    : new WebSocket(url);

  const listeners = new Set();
  const emitLocal = (name, payload) => {
    for (const fn of listeners) {
      try {
        fn(name, payload);
      } catch {}
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("连接 OfficeAce 实时通道超时")),
      timeout,
    );
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
    });
    ws.addEventListener("error", (e) => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`连接 OfficeAce 实时通道失败: ${e?.message ?? "error"}`));
      }
    });
    ws.addEventListener("close", (e) => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`OfficeAce 实时通道关闭: ${e?.code ?? ""}`));
      }
    });
    ws.addEventListener("message", async (ev) => {
      const data = typeof ev.data === "string" ? ev.data : await ev.data.text();

      if (data === "2") {
        ws.send("3"); // Engine.IO ping -> pong
        return;
      }
      if (data.startsWith("0")) {
        ws.send("40"); // 打开默认命名空间
        return;
      }
      if (data.startsWith("40")) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (data.startsWith("42")) {
        let parsed;
        try {
          parsed = JSON.parse(data.slice(2));
        } catch {
          return;
        }
        const [name, payload] = parsed;
        emitLocal(name, payload);
      }
    });
  });

  return {
    joinRoom(room) {
      ws.send(`42["join_room",${JSON.stringify(room)}]`);
    },
    leaveRoom(room) {
      ws.send(`42["leave_room",${JSON.stringify(room)}]`);
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
