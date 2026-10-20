// 订阅直连域探针: 用真实登录凭据依次试候选 apigOrigin, 定位 APIGW.0101 的正确域
import { runCloudLogin } from "../lib/oauth.mjs";
import { v11Headers } from "../lib/cloud.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
const m = res.metadata;
console.log("凭据 OK: AK=%s… project=%s token=%s…", String(m.iamAccessKey).slice(0, 6), m.iamProjectId || "(空)", String(m.iamSecurityToken).slice(0, 8));

const cred = { ak: m.iamAccessKey, sk: m.iamSecretKey, token: m.iamSecurityToken, projectId: m.iamProjectId };

const ORIGINS = [
  "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com",
  "https://agentarts.cn-southwest-2.myhuaweicloud.com",
  "https://versatile.cn-north-4.myhuaweicloud.com",
];

for (const origin of ORIGINS) {
  const url = `${origin}/v1/subscription`;
  for (const withProject of cred.projectId ? [true] : [false, true]) {
    const c = withProject && !cred.projectId ? { ...cred, projectId: "00000000000000000000000000000000" } : cred;
    const headers = v11Headers("GET", url, Buffer.alloc(0), c);
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
      const text = await r.text();
      console.log(`\n${origin}  project头=${c.projectId ? (withProject ? "带" : "无") : "假32零"}`);
      console.log(`  -> HTTP ${r.status} ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    } catch (e) {
      console.log(`\n${origin} -> 网络错误: ${e?.cause?.code ?? e?.message ?? e}`);
    }
  }
}
