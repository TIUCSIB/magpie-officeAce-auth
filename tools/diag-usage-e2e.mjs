// 最终验证: 模拟 magpie 的 usage() 直连解析路径, 输出卡片数据
import { runCloudLogin } from "../lib/oauth.mjs";
import { iamCredentialOf, readSubscriptionDirect, claimBonusDirect } from "../lib/cloud.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
const iam = iamCredentialOf(res);

const r = await readSubscriptionDirect(iam);
if (!r.ok) { console.error("订阅失败:", r.error); process.exit(1); }
const d = r.data;
const sku = Array.isArray(d?.skus) ? d.skus[0] : null;
const q = (sku?.quotas ?? []).find((x) => x?.sku_attr_code === "officeace_points");
const total = Number(q?.sku_value ?? 0);
const used = Number(q?.current_value ?? 0);
const unlimited = d?.subscribe_status === "SUBSCRIBED" && !q;
const money = (n) => (Number.isFinite(n) ? Math.round(n) : 0);
const daily = (d.bonus_skus ?? []).find((b) => /checkin|daily/i.test(String(b?.activity_id ?? "")));
console.log("== usage 卡片数据 ==");
console.log("积分余额:", unlimited ? "不限量" : `${money(Math.max(0, total - used))} / ${money(total)} 积分`);
console.log("每日签到:", daily ? `今日已签 ✓ +${money(daily.points)}` : "今日未签");
for (const b of d.bonus_skus ?? []) {
  if (/checkin|daily/i.test(String(b?.activity_id ?? ""))) continue;
  console.log("活动:", b.activity_name, `+${money(b.points)} 积分`);
}
console.log("套餐:", sku?.sku_name, sku?.expired_time?.slice(0, 10));

const ck = await claimBonusDirect(iam);
console.log("checkin:", ck.ok ? `ok points=${ck.points}` : ck.error);
