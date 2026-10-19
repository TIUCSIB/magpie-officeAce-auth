import { discoverSession } from "../lib/cookie.mjs";
import { OfficeAceClient } from "../lib/client.mjs";
const c = new OfficeAceClient({ cookie: discoverSession().cookie });
const list = await c.listModels();
console.log("OfficeAce 自己启用(enabled)的模型数:", list.length);
console.log(JSON.stringify(list.map(m => ({ model: m.model, enabled: m.enabled, name: m.displayName ?? m.name })), null, 1));
console.log("\n--- 原始第一条, 看有哪些字段 ---");
const r = await c.call("/api/maas-models");
console.log(JSON.stringify(r.json.list[0], null, 1));
