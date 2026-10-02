// 配置档案（吸收 claude-code-hooks 的 HOOK_SAFETY_LEVEL 分级 + redamon 的编排思路）。
// 一份档案 = 一整套开关（分组、自动应用、更新、注入、护栏、健康检查），一键切换。

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

const PROFILES = {
  // 红队全开：全部分组、自动应用、自动更新、护栏开。
  "king-redteam": {
    name: "红队全开 / Red-team full",
    desc: "全部补丁分组 + 自动应用 + 自动更新 + 护栏开。本机受控红队评测用。",
    groups: { prompt: true, code: true, engine: true, compat: true, tools: true },
    autoApplyOnStart: true,
    autoUpdateOnStart: true,
    guard: true,
    healthCheck: true,
  },
  // 标准：默认档，能力全开但更新手动。
  "king-standard": {
    name: "标准 / Standard",
    desc: "全部补丁分组 + 自动应用。更新与护栏按个人习惯再开。",
    groups: { prompt: true, code: true, engine: true, compat: true, tools: true },
    autoApplyOnStart: true,
    autoUpdateOnStart: false,
    guard: true,
    healthCheck: true,
  },
  // 只改提示词：最保守，不动代码层。
  "king-prompt-only": {
    name: "仅提示词 / Prompt-only",
    desc: "只应用提示词与兼容层，不动代码/引擎/工具默认值。",
    groups: { prompt: true, code: false, engine: false, compat: true, tools: false },
    autoApplyOnStart: true,
    autoUpdateOnStart: false,
    guard: false,
    healthCheck: true,
  },
  // 隐身：什么后续动作都不做，补丁打完不再自动重应用/更新，最小 footprint。
  "king-stealth": {
    name: "隐身 / Stealth",
    desc: "补丁可手动应用，但关闭启动自动应用、自动更新、护栏，最小运行足迹。",
    groups: { prompt: true, code: true, engine: true, compat: true, tools: true },
    autoApplyOnStart: false,
    autoUpdateOnStart: false,
    guard: false,
    healthCheck: false,
  },
};

const PROFILE_IDS = Object.keys(PROFILES);
const DEFAULT_PROFILE = "king-standard";

export function profileIds() {
  return PROFILE_IDS;
}

export function profileMeta(id) {
  return PROFILES[id] || null;
}

export function statePath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-king", "profile.json");
}

export function readActiveProfile(dshHome = findDshHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dshHome), "utf8"));
    return {
      active: PROFILE_IDS.includes(raw?.active) ? raw.active : DEFAULT_PROFILE,
      custom: raw?.custom && typeof raw.custom === "object" ? raw.custom : {},
    };
  } catch {
    return { active: DEFAULT_PROFILE, custom: {} };
  }
}

async function writeActiveProfile(dshHome, active, custom = {}) {
  await fsp.mkdir(path.dirname(statePath(dshHome)), { recursive: true });
  await fsp.writeFile(statePath(dshHome), `${JSON.stringify({ active, custom, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

// 应用档案：把档案里的开关写进插件的运行时配置与分组状态。
export async function applyProfile(dshHome, id, { setGroups, setGuard } = {}) {
  const meta = PROFILES[id];
  if (!meta) return { ok: false, error: "unknown_profile" };
  if (typeof setGroups === "function") await setGroups(dshHome, meta.groups);
  if (typeof setGuard === "function") await setGuard(dshHome, meta.guard);
  await writeActiveProfile(dshHome, id);
  return { ok: true, id, ...meta };
}

export function effectiveConfig(dshHome = findDshHome()) {
  const { active, custom } = readActiveProfile(dshHome);
  const base = PROFILES[active] || PROFILES[DEFAULT_PROFILE];
  const merged = {
    profile: active,
    ...base,
    groups: { ...base.groups, ...(custom.groups || {}) },
    autoApplyOnStart: custom.autoApplyOnStart ?? base.autoApplyOnStart,
    autoUpdateOnStart: custom.autoUpdateOnStart ?? base.autoUpdateOnStart,
    guard: custom.guard ?? base.guard,
    healthCheck: custom.healthCheck ?? base.healthCheck,
  };
  return merged;
}

// 在档案之上叠加一次性覆盖（不改变档案本身，只改本次生效值）。
export async function overrideProfile(dshHome, patch) {
  const { active, custom } = readActiveProfile(dshHome);
  const next = {
    ...custom,
    ...(patch.groups ? { groups: { ...custom.groups, ...patch.groups } } : {}),
    ...(patch.autoApplyOnStart !== undefined ? { autoApplyOnStart: patch.autoApplyOnStart } : {}),
    ...(patch.autoUpdateOnStart !== undefined ? { autoUpdateOnStart: patch.autoUpdateOnStart } : {}),
    ...(patch.guard !== undefined ? { guard: patch.guard } : {}),
    ...(patch.healthCheck !== undefined ? { healthCheck: patch.healthCheck } : {}),
  };
  await writeActiveProfile(dshHome, active, next);
  return effectiveConfig(dshHome);
}

export function renderProfileList(dshHome = findDshHome()) {
  const { active } = readActiveProfile(dshHome);
  const out = ["配置档案 / Profiles", `  状态文件 ${statePath(dshHome)}`];
  for (const id of PROFILE_IDS) {
    const meta = PROFILES[id];
    const on = id === active;
    out.push(`  ${on ? "▶" : "·"} ${id} ${meta.name} ${on ? "★ 当前" : ""}`);
    out.push(`      ${meta.desc}`);
    out.push(`      groups=${Object.entries(meta.groups).filter(([, v]) => v).map(([k]) => k).join(",") || "none"} autoApply=${meta.autoApplyOnStart} autoUpdate=${meta.autoUpdateOnStart} guard=${meta.guard}`);
  }
  out.push("", "切换: /king profile use <id>  覆盖: /king profile set <key> <value>");
  return out.join("\n");
}
