// 兜底链路: 走 OfficeAce 的「智能体 + 会话 + 消息」, 与桌面端界面等价。
//
//   POST /api/threads           建会话(可带 preferredModel 指定后端模型)
//   POST /api/messages          发一条消息, 立刻返回 invocationId
//   socket.io thread:<id>       agent_message 帧: type=text 逐字增量,
//                               type=done+isFinal 收尾, system_info 带 usage
//
// 代价: 每一轮都会带上智能体的固定系统提示(人设 + 技能 + 记忆检索)。
//   实测 prompt_tokens ≈ 51928。仅在直连网关不可用时使用。
import { OfficeAceClient } from "./client.mjs";
import { openSocket } from "./socket.mjs";

const DEFAULT_AGENT = process.env.MAGPIE_OFFICEACE_AGENT || "office";
const DEFAULT_MODEL_ACCOUNT = process.env.MAGPIE_OFFICEACE_MODEL_ACCOUNT || "huawei-maas";
const TIMEOUT_MS = Number(process.env.MAGPIE_OFFICEACE_TIMEOUT_MS || 300000);
const POLL_MS = Number(process.env.MAGPIE_OFFICEACE_POLL_MS || 500);

export { DEFAULT_AGENT };

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image_url") return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** OpenAI messages -> 单段提示词 (OfficeAce 的 /api/messages 只吃一条 content) */
export function messagesToPrompt(messages = []) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    const text = contentToText(m?.content).trim();
    const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
    if (!text && !calls.length) continue;
    switch (m?.role) {
      case "system":
      case "developer":
        system.push(text);
        break;
      case "assistant":
        if (calls.length) {
          turns.push(`[助手]\n${text ? `${text}\n` : ""}${JSON.stringify(calls)}`);
        } else {
          turns.push(`[助手]\n${text}`);
        }
        break;
      case "tool":
        turns.push(`[工具结果]\n${text}`);
        break;
      default:
        turns.push(`[用户]\n${text}`);
    }
  }
  const parts = [];
  if (system.length) parts.push(`以下是调用方给出的系统指令, 请严格遵守:\n\n${system.join("\n\n")}`);
  if (!turns.length) return parts.join("\n\n") || "你好";
  if (turns.length === 1 && turns[0].startsWith("[用户]\n")) {
    parts.push(turns[0].slice("[用户]\n".length));
  } else {
    parts.push(`以下是多轮对话记录, 请针对最后一条[用户]消息作答:\n\n${turns.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

/** 用量帧 -> OpenAI usage */
export function parseUsage(frame) {
  if (!frame) return null;
  let data = frame;
  if (typeof frame === "string") {
    try {
      data = JSON.parse(frame);
    } catch {
      return null;
    }
  }
  const u = data?.usage ?? data;
  const prompt = Number(u?.inputTokens ?? u?.prompt_tokens ?? 0) || 0;
  const completion = Number(u?.outputTokens ?? u?.completion_tokens ?? 0) || 0;
  if (!prompt && !completion) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** 跑一轮智能体会话, 通过 socket.io 逐字回传。 */
export async function runTurn({ client, agentId, preferredModel, prompt, onDelta, onUsage, signal, log }) {
  const thread = await client.createThread(`magpie-${agentId}`, {
    preferredModel: preferredModel || undefined,
    preferredModelAccountRef: preferredModel ? DEFAULT_MODEL_ACCOUNT : undefined,
  });
  const room = `thread:${thread.id}`;
  let socket = null;
  let finished = false;

  try {
    try {
      socket = await openSocket({ base: client.base, cookie: client.cookie });
    } catch (err) {
      log?.warn?.(`实时通道不可用, 改用轮询: ${err?.message ?? err}`);
    }

    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 OfficeAce 应答超时(${TIMEOUT_MS}ms)`)),
        TIMEOUT_MS,
      );

      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      if (!socket) {
        // 降级路径: 轮询 REST。草稿在收尾前 content 为空, 只能整段拿。
        (async () => {
          try {
            const baseline = new Set((await client.listMessages(thread.id, 60)).map((m) => m.id));
            for (;;) {
              if (signal?.aborted) throw new Error("请求已取消");
              await new Promise((r) => setTimeout(r, POLL_MS));
              const msgs = await client.listMessages(thread.id, 60);
              const ok = msgs.find(
                (m) =>
                  m?.type === "assistant" &&
                  !baseline.has(m.id) &&
                  !m.isDraft &&
                  typeof m.content === "string" &&
                  m.content.length > 0,
              );
              if (ok) {
                onDelta?.(ok.content, true);
                return finish();
              }
            }
          } catch (err) {
            finish(err);
          }
        })();
        return;
      }

      socket.onEvent((name, payload) => {
        if (name !== "agent_message" || !payload) return;
        if (payload.threadId && payload.threadId !== thread.id) return;

        if (payload.type === "text" && typeof payload.content === "string" && payload.content) {
          onDelta?.(payload.content, false);
          return;
        }
        if (payload.type === "system_info") {
          const usage = parseUsage(payload.content);
          if (usage) onUsage?.(usage);
          return;
        }
        if (payload.type === "error") {
          return finish(new Error(String(payload.error ?? payload.content ?? "OfficeAce 返回错误")));
        }
        if (payload.type === "done" && payload.isFinal) {
          return finish();
        }
      });

      socket.joinRoom(room);

      // 房间授权是异步的, 给它一点时间再发消息
      setTimeout(() => {
        client.sendMessage({ threadId: thread.id, content: prompt, agentId, signal }).catch((err) =>
          finish(err),
        );
      }, 300);
    });

    await done;
    return thread;
  } finally {
    socket?.close();
    client.deleteThread(thread.id).catch(() => {});
  }
}

export function makeClient(cookie, base) {
  return new OfficeAceClient({ cookie, base });
}
