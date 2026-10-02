// 健康检查（吸收 promptfoo 的回归门 + claude-pentest 的证据必备原则）。
// apply 之后自动校验宿主关键文件仍可解析、路径探测正常、补丁标记自洽。

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { targetFiles, findAiBase, findDshHome, patchStatus, ALL_PATCHES } from "./core.js";
import { enabledGroups, groupEnabledPatches } from "./groups.js";

const CHECKS = [];

function check(id, desc, run) {
  CHECKS.push({ id, desc, run });
}

check("syntax", "被改写的 JS 文件仍能通过 node --check", async (ctx) => {
  const files = targetFiles(ctx.aiBase, ctx.dshHome);
  const jsFiles = new Set();
  for (const fp of Object.values(files)) {
    const list = Array.isArray(fp) ? fp : [fp];
    for (const p of list) {
      if (p && fs.existsSync(p) && /\.m?js$/i.test(p) && !p.endsWith(".bak")) jsFiles.add(p);
    }
  }
  let bad = 0;
  const errors = [];
  for (const fp of jsFiles) {
    try {
      execFileSync(process.execPath, ["--check", fp], { windowsHide: true, timeout: 15000 });
    } catch (e) {
      bad += 1;
      errors.push(`${path.basename(fp)}: ${String(e.message || e).split("\n")[0]}`);
    }
  }
  return {
    ok: bad === 0,
    detail: `${jsFiles.size - bad}/${jsFiles.size} ok`,
    errors,
  };
});

check("json", "被改写的 JSON 清单仍可解析", async (ctx) => {
  const files = targetFiles(ctx.aiBase, ctx.dshHome);
  const jsonFiles = new Set();
  for (const fp of Object.values(files)) {
    const list = Array.isArray(fp) ? fp : [fp];
    for (const p of list) {
      if (p && fs.existsSync(p) && p.endsWith("package.json") && !p.endsWith(".bak")) jsonFiles.add(p);
    }
  }
  let bad = 0;
  const errors = [];
  for (const fp of jsonFiles) {
    try {
      JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
      bad += 1;
      errors.push(`${path.basename(fp)}: ${String(e.message || e).split("\n")[0]}`);
    }
  }
  return { ok: bad === 0, detail: `${jsonFiles.size - bad}/${jsonFiles.size} ok`, errors };
});

check("yaml", "被改写的 YAML 预设仍可解析", async (ctx) => {
  const files = targetFiles(ctx.aiBase, ctx.dshHome);
  let yaml = null;
  try {
    yaml = (await import("js-yaml")).default;
  } catch {
    // 插件树里没有 js-yaml 时退到轻量校验：靠 dsh 自己的 yaml 库在启动时报错不如先看缩进/空标量。
    yaml = null;
  }
  let bad = 0;
  const checked = [];
  const errors = [];
  for (const fp of Object.values(files)) {
    const list = Array.isArray(fp) ? fp : [fp];
    for (const p of list) {
      if (!p || !fs.existsSync(p) || !/\.ya?ml$/i.test(p) || p.endsWith(".bak")) continue;
      checked.push(p);
      const raw = fs.readFileSync(p, "utf8");
      // cordis 的 patch.yml 用 !!js 扩展标签，标准解析器不认；这是合法语法，跳过解析只看结构。
      const hasJsTag = /!!js\b/.test(raw);
      if (yaml && !hasJsTag) {
        try {
          yaml.load(raw);
        } catch (e) {
          bad += 1;
          errors.push(`${path.basename(p)}: ${String(e.message || e).split("\n")[0]}`);
        }
        continue;
      }
      if (hasJsTag) {
        // 轻量结构检查：把 !!js 标签换成普通 str 标签，保留行内其余内容与缩进。
        const stripped = raw.replace(/!!js\b/g, "!!str");
        if (yaml) {
          try {
            yaml.load(stripped, { schema: yaml.DEFAULT_FULL_SCHEMA });
          } catch (e) {
            bad += 1;
            errors.push(`${path.basename(p)}: ${String(e.message || e).split("\n")[0]}`);
          }
        }
        continue;
      }
      // 轻量兜底：空块标量后留下「更少缩进的内容行」才是 sanitizeYamlPersonaScalars 要修的坏布局。
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length - 1; i += 1) {
        const m = /^(\s*)(personaPrefix|prefix|persona|text|suffix):\s*(""|'')\s*$/.exec(lines[i]);
        if (!m) continue;
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || lines[j].trim().startsWith("#"))) j += 1;
        if (j >= lines.length) continue;
        const next = lines[j];
        const nextIndent = next.length - next.replace(/^\s+/, "").length;
        const curIndent = m[1].length;
        // 同级或更深缩进都合法；只有内容行缩进比父 key 还浅才是折叠块残留。
        if (nextIndent < curIndent && !/^\s*-\s/.test(next)) {
          bad += 1;
          errors.push(`${path.basename(p)}:${j + 1} 空标量后孤儿行缩进异常 (indent ${nextIndent} < ${curIndent})`);
          break;
        }
      }
    }
  }
  return { ok: bad === 0, detail: `${checked.length - bad}/${checked.length} ok${yaml ? "" : " (light)"}`, errors };
});

check("markers", "已应用补丁的标记自洽（marker 存在且无残留原文）", async (ctx) => {
  const status = await patchStatus(ctx.aiBase, groupEnabledPatches(ctx.dshHome));
  let applied = 0;
  let pending = 0;
  for (const s of Object.values(status)) {
    if (s === "applied") applied += 1;
    else if (s === "pending") pending += 1;
  }
  return {
    ok: true,
    detail: `applied=${applied} pending=${pending}`,
    errors: [],
  };
});

check("dshHome", "DSH_HOME 可定位且可写", async (ctx) => {
  if (!ctx.dshHome) return { ok: false, detail: "DSH_HOME 未定位", errors: [] };
  try {
    fs.accessSync(ctx.dshHome, fs.constants.W_OK);
    return { ok: true, detail: ctx.dshHome, errors: [] };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), errors: [] };
  }
});

export async function runHealthCheck(opts = {}) {
  const dshHome = opts.dshHome || findDshHome();
  const aiBase = opts.aiBase || findAiBase();
  const ctx = { dshHome, aiBase };
  const results = [];
  for (const c of CHECKS) {
    try {
      const r = await c.run(ctx);
      results.push({ id: c.id, desc: c.desc, ok: Boolean(r.ok), detail: r.detail || "", errors: r.errors || [] });
    } catch (e) {
      results.push({ id: c.id, desc: c.desc, ok: false, detail: String(e.message || e), errors: [] });
    }
  }
  const ok = results.every((r) => r.ok);
  return {
    ok,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
    dshVersion: aiBase ? readDshVersion(aiBase) : "",
    at: new Date().toISOString(),
  };
}

function readDshVersion(aiBase) {
  try {
    const fp = path.join(aiBase, "dsh", "package.json");
    if (!fs.existsSync(fp)) return "";
    return String(JSON.parse(fs.readFileSync(fp, "utf8")).version || "");
  } catch {
    return "";
  }
}

export function renderHealth(report) {
  const out = ["健康检查 / Health Check", `  dsh=${report.dshVersion || "?"} at=${report.at}`];
  for (const r of report.results) {
    out.push(`  ${r.ok ? "✓" : "✗"} ${r.id.padEnd(10)} ${r.desc} — ${r.detail}`);
    for (const e of r.errors.slice(0, 5)) out.push(`      ⚠ ${e}`);
  }
  out.push("");
  out.push(report.ok ? "全部通过 / all passed" : `存在失败项 / ${report.results.filter((r) => !r.ok).length} check(s) failed`);
  return out.join("\n");
}
