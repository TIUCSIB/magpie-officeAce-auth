import { OfficeAcePlugin } from "../index.mjs";
import { discoverSession } from "../lib/cookie.mjs";
import { readSubscription, claimBonus, clientFor } from "../lib/subscription.mjs";
const cookie = discoverSession().cookie;

console.log("=== 只读: subscription/current ===");
const sub = await readSubscription(clientFor(cookie));
console.log(JSON.stringify(sub, null, 1).slice(0, 700));

console.log("\n=== 签到幂等性: 连调两次 claim-bonus ===");
for (let i = 1; i <= 2; i++) {
  const r = await claimBonus(clientFor(cookie));
  console.log(`  第${i}次 -> ok=${r.ok} points=${r.points} skus=${JSON.stringify(r.skus)} ${r.error ?? ""}`);
}

console.log("\n=== 插件 checkin() ===");
const hooks = await OfficeAcePlugin({ client: { app: { log: () => {} } } });
console.log(JSON.stringify(await hooks.checkin(async () => ({ type: "api", key: cookie }))));
