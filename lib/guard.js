// 护栏反篡改（吸收 karanb192/claude-code-hooks 的 config-guard / config-watch）。
// dsh-king 的状态目录、插件树、基线、钩子脚本列为受保护对象；会话内工具试图改写时拦截并告警。
// 检测与执法分离：fs 观察做发现，agent/pre-step 与工具结果做执法提示。

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

const PROTECTED_NAMES = new Set([
  "patch-groups.json",
  "baselines.json",
  "hooks.json",
  "guard.json",
  "override-state.json",
]);

// 插件运行时自己写的状态文件：变更不构成篡改告警。
const SELF_WRITTEN = new Set([
  "guard.json",
  "armory.json",
  "profile.json",
  "patch-groups.json",
  "baselines.json",
]);

export function guardStatePath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-king", "guard.json");
}

export function readGuardState(dshHome = findDshHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(guardStatePath(dshHome), "utf8"));
    return {
      enabled: raw?.enabled !== false,
      alerts: Array.isArray(raw?.alerts) ? raw.alerts.slice(-200) : [],
    };
  } catch {
    return { enabled: true, alerts: [] };
  }
}

async function writeGuardState(dshHome, state) {
  await fsp.mkdir(path.dirname(guardStatePath(dshHome)), { recursive: true });
  await fsp.writeFile(guardStatePath(dshHome), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function setGuardEnabled(dshHome, enabled) {
  const state = readGuardState(dshHome);
  state.enabled = Boolean(enabled);
  await writeGuardState(dshHome, state);
  return state;
}

// 受保护路径集合：dsh-king 状态目录、插件自身目录、用户规则/技能目录的可选保护。
export function protectedRoots(dshHome = findDshHome()) {
  const roots = [path.join(dshHome, "dsh-king")];
  const pluginSelf = pluginOwnDir();
  if (pluginSelf) roots.push(pluginSelf);
  return roots;
}

function pluginOwnDir() {
  try {
    const here = new URL("..", import.meta.url);
    return fs.realpathSync(new URL(here).pathname ? here.pathname : here);
  } catch {
    return "";
  }
}

function isProtected(target, dshHome) {
  const p = String(target || "").replace(/\\/g, "/");
  if (!p) return false;
  for (const root of protectedRoots(dshHome)) {
    const r = root.replace(/\\/g, "/");
    if (!r) continue;
    if (p === r || p.startsWith(r.endsWith("/") ? r : r + "/")) return true;
  }
  const base = path.basename(p);
  if (PROTECTED_NAMES.has(base) && p.includes("/dsh-king/")) return true;
  return false;
}

// 落盘一条告警（保留最近 200 条）。
export async function recordAlert(dshHome, alert) {
  const state = readGuardState(dshHome);
  state.alerts.push({ at: new Date().toISOString(), ...alert });
  state.alerts = state.alerts.slice(-200);
  await writeGuardState(dshHome, state);
  return state;
}

// 文件事件做发现：watch 受保护目录，任何变更都记录并标记 needs_review。
export function installFsWatcher(dshHome, onAlert) {
  if (typeof fs.watch !== "function") return () => {};
  const dirs = protectedRoots(dshHome).filter((d) => fs.existsSync(d));
  const closers = [];
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const base = String(filename).replace(/\\/g, "/").split("/").pop();
        // 插件自己写状态文件不算篡改：guard/baselines/patch-groups 的常规写操作。
        if (SELF_WRITTEN.has(base)) return;
        const alert = {
          kind: "fs_change",
          path: path.join(dir, String(filename)),
          event: _event,
        };
        recordAlert(dshHome, alert).catch(() => {});
        if (typeof onAlert === "function") onAlert(alert);
      });
      closers.push(() => w.close());
    } catch { /* 目录不存在或不可监听 */ }
  }
  return () => closers.forEach((c) => { try { c(); } catch { /* ignore */ } });
}

// 执法臂：挂在会话钩子上，发现受保护路径被改时在工具结果里追加告警，强制人工介入。
export function installGuardHook(ctx, dshHome) {
  if (typeof ctx?.on !== "function") return;
  if (ctx.__dshKingGuardHook) return;
  ctx.__dshKingGuardHook = true;
  const state = readGuardState(dshHome);
  if (!state.enabled) return;

  const notify = async (info) => {
    await recordAlert(dshHome, info);
  };

  ctx.on("agent/pre-step", async (_payload, next) => {
    const decision = await next();
    const state = readGuardState(dshHome);
    if (!state.enabled || !state.alerts.length) return decision;
    const recent = state.alerts[state.alerts.length - 1];
    if (recent?.kind !== "fs_change") return decision;
    // 只在「刚刚被改」时提示一次，避免每轮重复。
    const age = Date.now() - new Date(recent.at).getTime();
    if (age > 30000) return decision;
    console.warn(
      `[dsh-king] guard: 受保护路径被修改 ${recent.path}（${recent.event}）。` +
      `若不是你主动操作的，请用 /king guard review 检查。`,
    );
    return decision;
  }, { global: true });
}

export function renderGuardStatus(dshHome = findDshHome()) {
  const state = readGuardState(dshHome);
  const out = ["护栏反篡改 / Anti-tamper Guard", `  状态 ${state.enabled ? "▶ 开" : "· 关"}`];
  out.push("  受保护路径 / protected:");
  for (const r of protectedRoots(dshHome)) out.push(`    · ${r}`);
  if (!state.alerts.length) {
    out.push("  (暂无告警)");
    return out.join("\n");
  }
  out.push(`  告警 ${state.alerts.length} 条（最近 10 条）:`);
  for (const a of state.alerts.slice(-10)) {
    out.push(`    · ${a.at} ${a.kind} ${a.path || ""} ${a.event || a.tool || ""}`);
  }
  return out.join("\n");
}

export async function clearAlerts(dshHome) {
  const state = readGuardState(dshHome);
  state.alerts = [];
  await writeGuardState(dshHome, state);
  return state;
}

// 供工具结果层调用：检查一次工具调用是否触碰了受保护路径。
export function checkToolTarget(toolName, target, dshHome = findDshHome()) {
  const state = readGuardState(dshHome);
  if (!state.enabled) return { hit: false };
  if (!isProtected(target, dshHome)) return { hit: false };
  return {
    hit: true,
    tool: String(toolName || ""),
    target,
    message: `[dsh-king] guard: ${toolName} 试图修改受保护路径 ${target}。这是 dsh-king 的状态/护栏文件。若确需修改，先用 /king guard off 关闭护栏。`,
  };
}
