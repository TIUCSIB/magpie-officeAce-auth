// OfficeAce 的订阅 / 积分 / 签到。
//
// 接口来自渲染层逆向(app.asar 里 SubscriptionStateProvider):
//   GET  /api/subscription/current        -> { totalCredits, usedCredits, unlimitedCredits,
//                                             plan, tier, bonusSkus, countDownStatus, expiresAt }
//   POST /api/subscription/claim-bonus    -> { bonusSkus: [{ points, name, expired }] }
//   GET  /api/subscription/gate-config    -> { featureAccess }
//   GET  /api/subscription/usage          -> 按小时/按天的消耗曲线
//
// 前端对 claim-bonus 是「每小时试一次」, 服务端幂等(没得领就不给),
// 所以补签可以随便调。真正的每日签到就是它。
//
// 注意: 这几个接口在 OfficeAce 本地 API(127.0.0.1:3004)后面, 需要 App 在运行。
// 模型那条直连链路不需要, 但积分这条需要。
import { OfficeAceClient } from "./client.mjs";

/** 订阅信息归一化; 拿不到就返回 { ok:false } */
export async function readSubscription(client, now = Date.now()) {
  const r = await client.call("/api/subscription/current");
  if (r.status !== 200 || !r.json) {
    return { ok: false, error: `订阅接口 HTTP ${r.status}` };
  }
  const d = r.json;
  const total = Number(d.totalCredits);
  const used = Number(d.usedCredits);
  const unlimited = d.unlimitedCredits === true || total < 0;
  const remaining = unlimited ? Infinity : Math.max(0, total - used);
  // 剩余百分比; magpie 的窗口条吃的是「已用」百分比, 所以下面会取 100 - percent
  const percent = unlimited || !(total > 0) ? 100 : Math.round((remaining / total) * 100);

  const bonuses = (Array.isArray(d.bonusSkus) ? d.bonusSkus : []).map((s) => ({
    id: String(s?.activityId ?? ""),
    name: String(s?.activityName ?? ""),
    points: Number(s?.points) || 0,
    consumed: Number(s?.currentValue) || 0,
    expiresAt: s?.expiredTime ?? null,
    grantedAt: s?.effectiveTime ?? null,
  }));

  // 「每日签到有礼」今天是否已经领过: 看这份奖励是不是今天生效的
  const daily = bonuses.find((b) => /checkin|daily/i.test(b.id)) ?? null;
  const isToday = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return false;
    const a = new Date(t);
    const b = new Date(now);
    return (
      a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate()
    );
  };

  return {
    ok: true,
    total,
    used,
    remaining,
    unlimited,
    percent,
    plan: d.plan ?? d.tier ?? null,
    active: d.status === "active" || d.status === "trial" || d.countDownStatus === 2,
    expiresAt: d.expiresAt ?? null,
    bonuses,
    daily: daily
      ? { points: daily.points, claimedToday: isToday(daily.grantedAt), expiresAt: daily.expiresAt }
      : null,
  };
}

/** 签到(领当日积分)。服务端幂等。 */
export async function claimBonus(client) {
  const r = await client.call("/api/subscription/claim-bonus", { method: "POST", body: {} });
  if (r.status !== 200) {
    return { ok: false, error: `签到接口 HTTP ${r.status} ${r.body.slice(0, 200)}` };
  }
  const skus = Array.isArray(r.json?.bonusSkus) ? r.json.bonusSkus : [];
  const points = skus.reduce((a, s) => a + (Number(s?.points) || 0), 0);
  return { ok: true, points, skus };
}

export function clientFor(cookie, base) {
  return new OfficeAceClient({ cookie, base });
}

/** 本地 API 没起来时的统一提示 */
export const OFFLINE_HINT = "OfficeAce 未运行(积分/签到走它的本地 API 127.0.0.1:3004)";
