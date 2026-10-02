// dsh-purge 接管迁移：检测旧 dsh-purge 的补丁产物，平滑接管为 dsh-king。
// 旧产物：$DSH_HOME/dsh-purge/override-state.json、<file>.dshpurge.bak 备份、shim 里的 "dsh-purge shim" 标记。

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { findDshHome, findAiBase, targetFiles } from "./core.js";

export function purgeStateDir(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-purge");
}

export function purgeOverrideState(dshHome = findDshHome()) {
  return path.join(purgeStateDir(dshHome), "override-state.json");
}

export function purgeInstalledRev(dshHome = findDshHome()) {
  return path.join(purgeStateDir(dshHome), "installed-rev");
}

export function detectPurgeArtifacts(dshHome = findDshHome(), aiBase = findAiBase()) {
  const found = {
    stateDir: fs.existsSync(purgeStateDir(dshHome)),
    overrideState: fs.existsSync(purgeOverrideState(dshHome)),
    installedRev: fs.existsSync(purgeInstalledRev(dshHome)),
    backups: [],
    shimMarks: [],
  };
  if (aiBase) {
    const files = targetFiles(aiBase, dshHome);
    for (const fp of Object.values(files)) {
      const list = Array.isArray(fp) ? fp : [fp];
      for (const p of list) {
        if (p && fs.existsSync(`${p}.dshpurge.bak`)) found.backups.push(`${p}.dshpurge.bak`);
      }
    }
  }
  return found;
}

export function purgeArtifactsSummary(artifacts) {
  const a = artifacts || {};
  const parts = [];
  if (a.stateDir) parts.push("状态目录");
  if (a.overrideState) parts.push("override-state.json");
  if (a.installedRev) parts.push("installed-rev");
  if (a.backups?.length) parts.push(`${a.backups.length} 个 .dshpurge.bak 备份`);
  return parts;
}

export function hasPurgeArtifacts(dshHome = findDshHome(), aiBase = findAiBase()) {
  const a = detectPurgeArtifacts(dshHome, aiBase);
  return Boolean(a.stateDir || a.overrideState || a.installedRev || a.backups.length);
}

// 迁移：把 .dshpurge.bak 改名（复制）为 .dshking.bak，旧 purge 状态目录保留（不删用户数据）。
// 返回迁移结果；不应用任何新补丁，只做备份接管。
export async function inheritPurgeBackups(dshHome = findDshHome(), aiBase = findAiBase()) {
  const artifacts = detectPurgeArtifacts(dshHome, aiBase);
  if (!artifacts.backups.length) return { ok: true, migrated: [], skipped: true };
  const migrated = [];
  const errors = [];
  for (const bak of artifacts.backups) {
    const target = bak.replace(/\.dshpurge\.bak$/, ".dshking.bak");
    try {
      if (!fs.existsSync(target)) {
        await fsp.copyFile(bak, target);
        migrated.push(target);
      }
    } catch (e) {
      errors.push([bak, String(e)]);
    }
  }
  return { ok: errors.length === 0, migrated, errors, skipped: false };
}

// 迁移 override 状态：旧 purge 的 customized/hash 记录沿用过来。
export async function inheritOverrideState(dshHome = findDshHome()) {
  const src = purgeOverrideState(dshHome);
  if (!fs.existsSync(src)) return { ok: false, error: "no_purge_state" };
  const dst = path.join(dshHome, "dsh-king", "override-state.json");
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf8"));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(dst, `${JSON.stringify({ ...raw, inheritedFrom: "dsh-purge", inheritedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return { ok: true, path: dst };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function inheritAll(dshHome = findDshHome(), aiBase = findAiBase()) {
  const backups = await inheritPurgeBackups(dshHome, aiBase);
  let override = null;
  if (fs.existsSync(purgeOverrideState(dshHome))) {
    override = await inheritOverrideState(dshHome);
  }
  return { backups, override, artifacts: detectPurgeArtifacts(dshHome, aiBase) };
}

export function renderInheritReport(result) {
  const out = ["接管 dsh-purge / Inherit dsh-purge"];
  const a = result.artifacts || {};
  const parts = purgeArtifactsSummary(a);
  out.push(`  检测到: ${parts.length ? parts.join("、") : "无"}`);
  if (result.backups?.migrated?.length) {
    out.push(`  ✓ 迁移备份 ${result.backups.migrated.length} 个 → .dshking.bak`);
  }
  for (const [p, e] of result.backups?.errors || []) out.push(`  ⚠ ${p}: ${e}`);
  if (result.override?.ok) out.push(`  ✓ 沿用 override 状态 → ${result.override.path}`);
  if (!parts.length) out.push("  没有旧 dsh-purge 产物，无需接管。");
  return out.join("\n");
}
