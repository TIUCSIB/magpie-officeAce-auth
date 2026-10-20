// 打印云端 /v1/subscription 完整原始响应, 用于映射 usage() 解析
import { runCloudLogin } from "../lib/oauth.mjs";
import { iamCredentialOf, clawRequest } from "../lib/cloud.mjs";

const res = await runCloudLogin({}, { log: { info: () => {} } });
if (res.type !== "success") { console.error("登录失败:", res.error); process.exit(1); }
const iam = iamCredentialOf(res);

const r = await clawRequest(iam, "GET", "/v1/subscription", undefined);
console.log("HTTP", r.status);
console.log(JSON.stringify(r.json, null, 2).slice(0, 3000));
