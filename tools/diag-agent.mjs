// 璇婃柇: preferredModel 鏄惁鐪熺殑钀藉埌浼氳瘽涓?import { discoverSession } from "../lib/cookie.mjs";
import { OfficeAceClient } from "../lib/client.mjs";

const { cookie } = discoverSession();
const client = new OfficeAceClient({ cookie });

const want = process.argv[2] || "glm-5.1";
const t = await client.createThread("magpie-diag", {
  preferredModel: want,
  preferredModelAccountRef: "huawei-maas",
});
console.log("寤轰細璇濊繑鍥?", JSON.stringify({ id: t.id, preferredModel: t.preferredModel, ref: t.preferredModelAccountRef }));

const back = await client.call(`/api/threads/${t.id}`);
console.log("鍥炶绾跨▼  :", JSON.stringify({ preferredModel: back.json?.preferredModel, ref: back.json?.preferredModelAccountRef }));

console.log("--- 鍙戞秷鎭?---");
const sent = await client.sendMessage({ threadId: t.id, content: "鍙洖澶? ok", agentId: "office" });
console.log("invocationId:", sent.invocationId);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const msgs = await client.listMessages(t.id, 30);
  const a = msgs.filter((m) => m.type === "assistant" && !m.isDraft).pop();
  if (a && a.content) {
    console.log("鍥炵瓟:", JSON.stringify(a.content.slice(0, 60)));
    break;
  }
}
await client.deleteThread(t.id);
console.log("threadId(渚涙煡鏃ュ織):", t.id);

