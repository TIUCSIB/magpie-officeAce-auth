// 探针: 云端 /v1/claw/auth/callback 的行为
// 1) 假 state + 假 code -> 看端点是否存在/报什么错
// 2) 真 state + 假 code -> 看 state 关联逻辑
const CLAW = "https://agentarts.cn-southwest-2.myhuaweicloud.com";

const stateRes = await fetch(`${CLAW}/v1/claw/auth/state`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const { state: realState } = await stateRes.json();
console.log("realState:", realState?.slice(0, 10) + "…");

for (const [tag, state] of [["假state", "probe-fake-state"], ["真state", realState]]) {
  const url = `${CLAW}/v1/claw/auth/callback?code=fake-code-123&state=${encodeURIComponent(state)}`;
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  console.log(`\n[${tag}] GET callback -> HTTP ${res.status} location=${res.headers.get("location") ?? "-"}`);
  console.log(`  body: ${text.slice(0, 300).replace(/\s+/g, " ")}`);

  // callback 后立刻轮询, 看云端状态是否变化
  const poll = await fetch(`${CLAW}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
    headers: { Accept: "application/json" },
  });
  console.log(`  poll after -> HTTP ${poll.status}`, (await poll.text()).slice(0, 160).replace(/\s+/g, " "));
}
