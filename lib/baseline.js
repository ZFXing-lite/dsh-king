// 宿主提示/代码基线快照库（吸收 Piebald-AI/claude-code-system-prompts 的基线 diff 思路）。
// apply 前给每个目标文件做带版本号的快照，回滚可退到任意快照，宿主升级后能算漂移。

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { targetFiles, findAiBase, findDshHome } from "./core.js";

const SNAP_DIR_NAME = "baselines";

export function baselineRoot(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-king", SNAP_DIR_NAME);
}

export function statePath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-king", "baselines.json");
}

function readStateSync(dshHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dshHome), "utf8"));
    return raw && typeof raw === "object" && Array.isArray(raw.items) ? raw : { items: [] };
  } catch {
    return { items: [] };
  }
}

async function writeState(dshHome, state) {
  await fsp.mkdir(path.dirname(statePath(dshHome)), { recursive: true });
  await fsp.writeFile(statePath(dshHome), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function dshVersionOf(aiBase) {
  try {
    const fp = path.join(aiBase, "dsh", "package.json");
    if (!fs.existsSync(fp)) return "";
    return String(JSON.parse(fs.readFileSync(fp, "utf8")).version || "");
  } catch {
    return "";
  }
}

export function listBaselines(dshHome = findDshHome()) {
  return readStateSync(dshHome).items;
}

export function baselineById(dshHome, id) {
  return listBaselines(dshHome).find((item) => item.id === id) || null;
}

// 对当前 targetFiles 全部已存在文件打快照，内容压缩落盘。
export async function takeBaseline(label = "", opts = {}) {
  const dshHome = opts.dshHome || findDshHome();
  const aiBase = opts.aiBase || findAiBase();
  if (!aiBase) return { ok: false, error: "ai_base_missing" };
  const files = targetFiles(aiBase, dshHome);
  const flat = [];
  for (const fp of Object.values(files)) {
    const list = Array.isArray(fp) ? fp : [fp];
    for (const p of list) if (p && fs.existsSync(p)) flat.push(p);
  }
  const stamp = new Date().toISOString().replace(/[^0-9a-zA-Z]/g, "").slice(0, 14);
  const id = `b${stamp}`;
  const dir = path.join(baselineRoot(dshHome), id);
  await fsp.mkdir(dir, { recursive: true });

  const entries = [];
  for (const fp of flat) {
    let buf;
    try {
      buf = fs.readFileSync(fp);
    } catch {
      continue;
    }
    const rel = path.relative(aiBase, fp).split(path.sep).join("/");
    const digest = sha256(buf);
    entries.push({ rel, digest, size: buf.length });
    const out = path.join(dir, `${rel.replace(/\//g, "__")}.gz`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, gzipSync(buf));
  }

  const state = readStateSync(dshHome);
  const item = {
    id,
    label: String(label || "").slice(0, 80),
    createdAt: new Date().toISOString(),
    dshVersion: dshVersionOf(aiBase),
    aiBase,
    files: entries,
  };
  // 同一时刻只留一份；旧的同名直接覆盖。
  state.items = state.items.filter((x) => x.id !== id);
  state.items.push(item);
  // 最多保留 12 份，最老的连同目录一起清掉。
  while (state.items.length > 12) {
    const dropped = state.items.shift();
    try {
      await fsp.rm(path.join(baselineRoot(dshHome), dropped.id), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  await writeState(dshHome, state);
  return { ok: true, id, files: entries.length };
}

// 当前文件 vs 指定基线：哪些变了、哪些新增、哪些基线里有但现在不存在。
export async function diffBaseline(id, opts = {}) {
  const dshHome = opts.dshHome || findDshHome();
  const aiBase = opts.aiBase || findAiBase();
  const item = baselineById(dshHome, id);
  if (!item) return { ok: false, error: "baseline_not_found" };
  const changed = [];
  const unchanged = [];
  for (const entry of item.files) {
    const fp = path.join(aiBase, ...entry.rel.split("/"));
    if (!fs.existsSync(fp)) {
      changed.push({ rel: entry.rel, status: "removed" });
      continue;
    }
    const digest = sha256(fs.readFileSync(fp));
    if (digest === entry.digest) unchanged.push(entry.rel);
    else changed.push({ rel: entry.rel, status: "modified" });
  }
  return { ok: true, id, dshVersion: item.dshVersion, changed, unchanged };
}

// 宿主升级后，官方文件被 npm 覆盖：报告哪些基线文件偏离了基线（说明补丁被冲掉了）。
export async function driftReport(opts = {}) {
  const items = listBaselines(opts.dshHome);
  if (items.length === 0) return { ok: false, error: "no_baseline" };
  const latest = items[items.length - 1];
  const diff = await diffBaseline(latest.id, opts);
  return { ok: true, baseline: latest.id, ...diff };
}

// 从基线还原：把基线里记录的文件内容写回（不动 .bak，可和 revertAll 互补）。
export async function restoreBaseline(id, opts = {}) {
  const dshHome = opts.dshHome || findDshHome();
  const aiBase = opts.aiBase || findAiBase();
  const item = baselineById(dshHome, id);
  if (!item) return { ok: false, error: "baseline_not_found" };
  const { gunzipSync } = await import("node:zlib");
  const dir = path.join(baselineRoot(dshHome), id);
  const restored = [];
  for (const entry of item.files) {
    const rel = `${entry.rel.replace(/\//g, "__")}.gz`;
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    const fp = path.join(aiBase, ...entry.rel.split("/"));
    try {
      const buf = gunzipSync(fs.readFileSync(src));
      await fsp.mkdir(path.dirname(fp), { recursive: true });
      await fsp.writeFile(fp, buf);
      restored.push(entry.rel);
    } catch { /* keep going */ }
  }
  return { ok: true, id, restored };
}

export async function deleteBaseline(id, dshHome = findDshHome()) {
  const state = readStateSync(dshHome);
  const before = state.items.length;
  state.items = state.items.filter((x) => x.id !== id);
  if (state.items.length === before) return { ok: false, error: "baseline_not_found" };
  await writeState(dshHome, state);
  try {
    await fsp.rm(path.join(baselineRoot(dshHome), id), { recursive: true, force: true });
  } catch { /* ignore */ }
  return { ok: true, id };
}

export function renderBaselineList(dshHome = findDshHome()) {
  const items = listBaselines(dshHome);
  const out = ["基线快照 / Baselines", `  目录 ${baselineRoot(dshHome)}`];
  if (!items.length) {
    out.push("  (暂无基线 — /king baseline take <标签> 打一份)");
    return out.join("\n");
  }
  for (const it of items) {
    const label = it.label ? ` ${it.label}` : "";
    out.push(`  · ${it.id}${label} files=${it.files.length} dsh=${it.dshVersion || "?"} ${it.createdAt}`);
  }
  return out.join("\n");
}
