// 端到端验证: 登录 -> 订阅余额直连 -> 签到直连(幂等)
import { runCloudLogin } from "../lib/oauth.mjs";
import { iamCredentialOf, readSubscriptionDirect, claimBonusDirect } from "../lib/cloud.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
console.log("登录: success");

const iam = iamCredentialOf(res);
console.log("IAM 凭据: AK=%s… projectId=%s", String(iam.ak).slice(0, 6), iam.projectId || "(空)");

const sub = await readSubscriptionDirect(iam);
if (!sub.ok) { console.error("订阅失败:", sub.error); process.exit(1); }
const d = sub.data;
const total = Number(d?.totalCredits), used = Number(d?.usedCredits);
console.log("订阅余额: total=%s used=%s unlimited=%s plan=%s", total, used, d?.unlimitedCredits, d?.plan ?? d?.tier);
console.log("skus 数:", Array.isArray(d?.skus) ? d.skus.length : 0);

const ck = await claimBonusDirect(iam);
console.log("签到:", ck.ok ? `ok, points=${ck.points}` : `失败: ${ck.error}`);
