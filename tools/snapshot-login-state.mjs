// 登录前后快照对比: 找出 OAuth 登录落地了哪些凭据
//   node tools/snapshot-login-state.mjs save     # 登录前
//   node tools/snapshot-login-state.mjs diff     # 登录后
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(homedir(), ".office-claw");
const SNAP = join(homedir(), ".office-claw", ".magpie-login-snapshot.json");

function hashOf(p) {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function keyFiles() {
  const out = [];
  const targets = [
    "session.cookie",
    "device-fingerprint.json",
    "connector-owner.local.json",
    "model.json",
    "user-cutover.json",
    "desktop-prefs.json",
    ".jiuwenclaw/config/routing_state",
    "users",
  ];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(json|txt|cookie)$/.test(e.name) || e.name === "session.cookie") {
        try {
          if (statSync(p).size < 2_000_000) out.push(p);
        } catch {}
      }
    }
  };
  walk(ROOT, 0);
  return out
    .filter((p) => !p.includes("sessions\\") && !p.includes("\\chat\\") && !p.includes("\\workspace\\") && !p.includes("\\skill"))
    .sort();
}

function wincredNames() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8", windowsHide: true });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("Target:"))
      .map((l) => l.replace(/^Target:\s*/, ""));
  } catch {
    return [];
  }
}

function snapshot() {
  const files = {};
  for (const p of keyFiles()) files[p.replace(ROOT + "\\", "").replace(/\\/g, "/")] = hashOf(p);
  return { at: new Date().toISOString(), files, wincred: wincredNames() };
}

const mode = process.argv[2];
if (mode === "save") {
  writeFileSync(SNAP, JSON.stringify(snapshot(), null, 1), "utf8");
  console.log("快照已存:", SNAP);
} else if (mode === "diff") {
  if (!existsSync(SNAP)) {
    console.error("先跑 save");
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(SNAP, "utf8"));
  const after = snapshot();
  const changed = [];
  const added = [];
  for (const [k, h] of Object.entries(after.files)) {
    if (!(k in before.files)) added.push(k);
    else if (before.files[k] !== h) changed.push(`${k}  (${before.files[k]} -> ${h})`);
  }
  const removed = Object.keys(before.files).filter((k) => !(k in after.files));
  console.log("== 变化的文件 ==");
  changed.forEach((c) => console.log("  *", c));
  console.log("== 新增文件 ==");
  added.forEach((a) => console.log("  +", a));
  console.log("== 消失文件 ==");
  removed.forEach((r) => console.log("  -", r));
  const credBefore = new Set(before.wincred);
  const credAfter = new Set(after.wincred);
  console.log("== Windows 凭据新增 ==");
  [...credAfter].filter((c) => !credBefore.has(c)).forEach((c) => console.log("  +", c));
  if (!changed.length && !added.length && !removed.length) console.log("  (无变化)");
}