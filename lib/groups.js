// 补丁分组 + 状态机（吸收 Stickman230/claude-pentest 的 status 生命周期与 claude-code-hooks 的分级策略）。
// 40 个补丁按层分组，每组可独立开关；每个补丁状态落盘，/king exit 统一重置但保留文件。

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ALL_PATCHES } from "./core.js";
import { findDshHome } from "./core.js";

export const GROUPS = Object.freeze({
  prompt: { name: "提示词层", name_en: "Prompt", desc: "免责声明、身份句、审批提示句", layer: "提示词" },
  code: { name: "代码默认层", name_en: "Code", desc: "沙箱/审批/工具上限的默认值", layer: "代码" },
  engine: { name: "引擎层", name_en: "Engine", desc: "审批门、沙箱执行、升级阶梯的运行时绕过", layer: "引擎" },
  compat: { name: "版本兼容层", name_en: "Compat", desc: "0.1.5 assemble / persona-text / developer 角色兼容", layer: "0.1.5 兼容" },
  tools: { name: "工具解锁层", name_en: "Tools", desc: "web-fetch / 预设 fetch / 桌面身份中立", layer: "工具" },
});

const DEFAULT_GROUPS = { prompt: true, code: true, engine: true, compat: true, tools: true };

function groupOf(patch) {
  // 补丁自身的 layer 字段是权威分组依据。
  const layer = String(patch.layer || "");
  if (layer.includes("0.1.5")) return "compat";
  if (layer === "提示词") return "prompt";
  if (layer === "工具") return "tools";
  // 引擎层补丁：审批门/沙箱执行/升级阶梯/工具行为改写，落在「代码」之外的运行时行为。
  const engineNames = new Set([
    "APPROVAL_AUTO_GRANT", "ESCALATION_WIDENING_EXEMPT", "ESCALATION_GRANT_UNCONDITIONAL",
    "SANDBOX_CONFINE_PASSTHROUGH", "FS_FENCE_DISABLED", "FS_OBSERVATION_INTENT_FREE",
    "REPEAT_TOOL_REMINDER_DISABLED", "TOOL_RESULT_PRUNER_DISABLED",
    "HOOKS_CLAUDE_DENY_ALLOW", "HOOKS_CODEX_DENY_ALLOW", "TOOL_SHELL_DENIAL_PROMPT",
    "SANDBOX_HINT_NEUTRAL", "ESCALATION_NEVER_REJECT", "TOOL_FS_ESCALATION_SCHEMA",
    "SUBAGENT_SCOPE_LOCK_NEUTRAL", "WEB_SURFACE_IDENTITY_NEUTRAL", "TOOL_WEB_UNTRUSTED_NEUTRAL",
  ]);
  if (engineNames.has(patch.name)) return "engine";
  return "code";
}

export function patchesByGroup() {
  const map = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, []]));
  for (const p of ALL_PATCHES) {
    const g = groupOf(p);
    if (map[g]) map[g].push(p);
  }
  return map;
}

export function groupForPatch(patch) {
  return groupOf(patch);
}

export function statePath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-king", "patch-groups.json");
}

export function readGroupState(dshHome = findDshHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dshHome), "utf8"));
    const groups = raw && typeof raw.groups === "object" ? raw.groups : {};
    return {
      groups: { ...DEFAULT_GROUPS, ...groups },
      statuses: raw && typeof raw.statuses === "object" ? raw.statuses : {},
    };
  } catch {
    return { groups: { ...DEFAULT_GROUPS }, statuses: {} };
  }
}

async function writeGroupState(dshHome, state) {
  await fsp.mkdir(path.dirname(statePath(dshHome)), { recursive: true });
  await fsp.writeFile(statePath(dshHome), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function setGroupEnabled(dshHome, group, enabled) {
  if (!GROUPS[group]) return { ok: false, error: "unknown_group" };
  const state = readGroupState(dshHome);
  state.groups[group] = Boolean(enabled);
  await writeGroupState(dshHome, state);
  return { ok: true, group, enabled: state.groups[group] };
}

export async function setGroups(dshHome, groups) {
  const state = readGroupState(dshHome);
  for (const [g, v] of Object.entries(groups || {})) {
    if (GROUPS[g]) state.groups[g] = Boolean(v);
  }
  await writeGroupState(dshHome, state);
  return { ok: true, groups: state.groups };
}

export function enabledGroups(dshHome = findDshHome()) {
  return readGroupState(dshHome).groups;
}

export function groupEnabledPatches(dshHome = findDshHome(), patches = ALL_PATCHES) {
  const groups = enabledGroups(dshHome);
  return patches.filter((p) => groups[groupOf(p)] !== false);
}

// 汇总 patch 运行状态（applied / pending / skipped / rolled-back / disabled），落盘并供 UI 展示。
export async function recordPatchStatuses(dshHome, patchStatus) {
  const state = readGroupState(dshHome);
  const groups = state.groups;
  for (const p of ALL_PATCHES) {
    const live = patchStatus?.[p.id];
    if (groups[groupOf(p)] === false) {
      state.statuses[String(p.id)] = "disabled";
      continue;
    }
    if (live === "applied") state.statuses[String(p.id)] = "active";
    else if (live === "missing_file" || live === "skipped") state.statuses[String(p.id)] = "skipped";
    else state.statuses[String(p.id)] = "pending";
  }
  await writeGroupState(dshHome, state);
  return state.statuses;
}

// exit 语义：把 active 补丁重置为 pending（等下次重新应用），状态文件保留可复用。
export async function resetStatuses(dshHome) {
  const state = readGroupState(dshHome);
  for (const key of Object.keys(state.statuses)) {
    if (state.statuses[key] === "active") state.statuses[key] = "pending";
  }
  await writeGroupState(dshHome, state);
  return state.statuses;
}

export function renderGroupStatus(dshHome = findDshHome()) {
  const state = readGroupState(dshHome);
  const byGroup = patchesByGroup();
  const out = ["补丁分组 / Patch Groups", `  状态文件 ${statePath(dshHome)}`, ""];
  for (const [g, meta] of Object.entries(GROUPS)) {
    const on = state.groups[g] !== false;
    const list = byGroup[g] || [];
    const active = list.filter((p) => state.statuses[String(p.id)] === "active").length;
    out.push(`  ${on ? "▶" : "·"} ${g} ${meta.name} / ${meta.name_en} — ${meta.desc}`);
    out.push(`      ${active}/${list.length} active · /king group ${g} ${on ? "off" : "on"}`);
  }
  return out.join("\n");
}
