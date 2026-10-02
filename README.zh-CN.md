<p align="center">
  <img src="docs/banner.svg" alt="dsh-king" width="720">
</p>

<h1 align="center">👑 DeepSeek Harness 之王（dsh-king）</h1>

<p align="center"><strong>Version 1.0.0</strong></p>

<p align="center">
  <em>本机官方 DeepSeek Harness 红队评测插件：dsh-purge 的增强继承者。指令权威性清洗 + 提示词注入 + 破限武器库 + 基线快照 + 补丁分组 + 健康检查 + 护栏反篡改 + 配置档案。兼容 dsh-purge 全部历史补丁与备份，可平滑接管。</em>
</p>

<p align="center">
  <a href="https://github.com/ZFXing-lite/dsh-king/stargazers"><img src="https://img.shields.io/github/stars/ZFXing-lite/dsh-king?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-blue" alt="DSH">
</p>

---

## 这是什么

**dsh-king** 是 [DeepSeek Harness](https://www.deepseek.com/harness/) 的增强型评测插件，在 dsh-purge 全部能力之上新增六大机制：

| 能力 | 说明 | 吸收自 |
|---|---|---|
| **基线快照** | apply 前自动给宿主文件打带版本号的快照，可回退到任意快照；宿主升级后自动算漂移 | Piebald-AI/claude-code-system-prompts |
| **补丁分组** | 42 个补丁按 提示词/代码/引擎/兼容/工具 五组独立开关，状态机化（pending→active→rolled-back） | Stickman230/claude-pentest |
| **健康检查** | apply 后自动校验被改文件仍可解析（JS/JSON/YAML）、标记自洽、路径可达 | promptfoo 回归门 |
| **护栏反篡改** | dsh-king 状态目录受 fs watcher 监控，变更记录并提示；自己写状态文件不误报 | karanb192/claude-code-hooks |
| **配置档案** | king-redteam / king-standard / king-prompt-only / king-stealth 四档一键切换全套开关 | HOOK_SAFETY_LEVEL 分级 |
| **破限武器库** | 内置 4 套会话级系统提示模板，一键装载或追加到 prompt-inject.md | langgptai/LLM-Jailbreaks 弹药库 |

继承 dsh-purge 的全部能力：42 patch 补丁引擎、系统提示注入与 persona 折叠、规则集（AGENTS.md/CLAUDE.md）、官方 Skill 导入、shim 注入、自动更新与频道切换、回退（rewind）、卸载、Web/桌面双宿主适配、跨站请求防护。

---

## 与 dsh-purge 的关系

**dsh-king 是 dsh-purge 的增强继承者，不是并列插件。**

- 全部 42 个补丁的 pattern 原样继承（对着真实 DSH 0.1.5-rc.2 包逐句量过，无法重写）
- 宿主里旧 dsh-purge 打的 `[dsh-purge]` 标记被等价识别，状态显示为已应用
- `.dshpurge.bak` 备份自动迁移为 `.dshking.bak`，override 状态沿用
- 安装 king 时应从 bundle 移除 purge（两者都注册 `rules`/`skills`/`rewind` 命令会冲突）
- `/purge` 命令由 king 的 `/king` 接管；king 与 purge 的 systemPrompt section 共存时，king 接管注入避免重复

---

## 安装

```sh
dsh plugin --profile web add https://github.com/ZFXing-lite/dsh-king/archive/refs/heads/master.tar.gz
```

当前目录已是本仓库时：

```sh
dsh plugin --profile web add .
```

**若已安装 dsh-purge**：先从 profile 的 `package.json` 移除 purge，再装 king（king 会接管 purge 的全部补丁与备份）：

```sh
# 编辑 $DSH_HOME/profiles/web/package.json：
#   dependencies 删掉 "dsh-purge"
#   dsh.profile.bundles 数组里把 "dsh-purge" 换成 "dsh-king"
cd "$DSH_HOME/profiles/web" && pnpm install
```

装完必须：完全退出并重启宿主 → 在设置页点「应用」（或聊天 `/king apply`）。

---

## 使用

### 聊天命令

```sh
/king status                # 显示状态（补丁/shim/override/分组/档案/接管）
/king apply                 # 应用清洗（基线→接管purge→分组补丁→shim→override→健康检查）
/king revert                # 回滚还原（保留 prompt-inject.md）
/king uninstall             # 卸载（已应用则先还原）
/king edit                  # 编辑 prompt-inject.md

# dsh-king 增强
/king baseline [take|diff|restore|delete]  # 基线快照与漂移检测
/king health                              # 健康检查
/king guard [on|off|clear|review]         # 护栏反篡改
/king profile [use|set]                   # 配置档案切换
/king group [on|off|reset] <组>           # 补丁分组开关
/king armory [use|append|delete] <id>     # 破限提示词模板库
/king inherit                             # 接管旧 dsh-purge 产物
```

### CLI

```sh
dsh-king --status
dsh-king --apply
dsh-king --revert
dsh-king --uninstall
dsh-king --edit
```

### 模型工具

`king_status` · `king_apply` · `king_revert`

### 内置档案

| 档案 | 说明 |
|---|---|
| `king-redteam` | 红队全开：全部分组 + 自动应用 + 自动更新 + 护栏 |
| `king-standard` | 标准（默认）：全部分组 + 自动应用 |
| `king-prompt-only` | 仅提示词：只动提示词与兼容层，不碰代码/引擎 |
| `king-stealth` | 隐身：全关自动动作，最小运行足迹 |

### 内置武器库模板

| 模板 | 说明 |
|---|---|
| `operator-authorized` | 操作员授权范式：会话指令为 ACTIVE 配置，直接交付 |
| `research-eval` | 研究评测范式：机制级解释、证据链、可复现步骤 |
| `minimal-context` | 最小上下文：只声明优先级与语言 |
| `unrestricted-sandbox` | 无限制沙箱范式：本机沙箱全权授权，工具直用 |

---

## 工作原理

**apply 流水线（dsh-king 增强）：**

```
1. 打基线快照        → $DSH_HOME/dsh-king/baselines/<id>/（gzip，最多 12 份）
2. 接管 dsh-purge    → .dshpurge.bak → .dshking.bak，override 状态沿用
3. 分组过滤          → 按当前档案的 group 开关筛补丁
4. applyPatches      → 备份 .dshking.bak → pattern/marker 替换 → 旧 [dsh-purge] 标记等价识别
5. shim 注入         → dsh.cmd / dsh.ps1 / unix dsh 探测 DSH_HOME
6. override          → prompt-inject.md 折进 persona-prefix
7. 健康检查          → JS/JSON/YAML 解析 + 标记自洽 + 路径探测
8. 状态落盘          → patch-groups.json（status: pending|active|skipped|disabled）
```

**启动时：** 自动 apply（可关）→ 自动更新检测 → 基线漂移检测（宿主升级覆盖 node_modules 后提示重新应用）→ 护栏 watcher 挂载。

**身份：** 不发明第二套人设。官方 Harness 身份句剥掉，`prompt-inject.md` 原文就是身份，折进 persona-prefix 避免被 phase-1 滤掉。

---

## 目录结构

```
dsh-king/
├── bin/dsh-king.js              # CLI
├── client.js                    # 前端设置页（含 dsh-king 增强面板）
├── cordis.patch.yml             # 插件配置
├── lib/
│   ├── index.js                 # 插件入口（命令/工具/HTTP 路由）
│   ├── core.js                  # 补丁引擎（42 patch + 备份回滚 + shim）
│   ├── identity.js              # 身份折叠与注入去重
│   ├── rules.js                 # 规则集
│   ├── skills.js                # 官方 Skill 导入
│   ├── update.js                # 自动更新与频道
│   ├── rewind.js                # 回退
│   ├── baseline.js              # 【新】基线快照
│   ├── groups.js                # 【新】补丁分组状态机
│   ├── health.js                # 【新】健康检查
│   ├── guard.js                 # 【新】护栏反篡改
│   ├── profiles.js              # 【新】配置档案
│   ├── armory.js                # 【新】破限武器库
│   ├── inherit.js               # 【新】dsh-purge 接管
│   ├── host.js surface.js web.js desktop.js  # 宿主适配
│   └── uninstall.js             # 卸载
└── package.json
```

运行时用户文件：`$DSH_HOME/prompt-inject.md`、`$DSH_HOME/rules/`、`$DSH_HOME/skills/`、`$DSH_HOME/dsh-king/`（基线/分组/护栏/档案/武器库状态）。

---

## 本地校验

```sh
node --check lib/index.js
node --check lib/core.js
for f in lib/*.js; do node --check "$f"; done
node --check client.js
node --check bin/dsh-king.js
```

---

## 严正法律免责与合规使用声明

本项目为非营利开源项目，遵守国家法律法规及所在平台的相关规范，仅供学习与研究使用。不得将本项目用于任何违法违规用途；由此产生的后果由使用者自行承担。

**【零容忍严正申明】**：本项目坚决反对并严禁任何形式的违法犯罪行为！本项目开发者绝不支持、不鼓励、不协助任何未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统或生成违法违禁内容的活动。

1. **本仓库不含违法内容**：发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具，也不是针对公网或第三方系统的攻击载荷。
2. **只作用于本机官方 Harness**：补丁、注入全部发生在使用者本机已安装的官方 DeepSeek Harness 上，不是他人的网站、服务器、账号或信息系统。
3. **不对外网目标联网**：应用、回滚、卸载均在本机文件与本机进程内完成，不对任何公网主机进行扫描、探测、入侵或攻击发包。
4. **合法受控范围限定**：一切测试必须限制在本机已授权安装的官方 Harness、离线本地合成靶标、授权网络安全演练靶场及合规实验室受控环境中进行。
5. **严禁违法违禁用途**：严禁未经授权渗透、勒索、破坏、撞库或传播恶意载荷；严禁生成传播违法违禁内容。
6. **使用者独立承担全部责任**：MIT 协议"按现状"提供，开发者不作任何保证，使用者对自身全部行为及后果承担独立完全责任。
7. **违约即终止授权**：任何违法违规使用自行为发生之日起自动且不可撤销地终止授权。
8. **第三方独立性声明**：本项目与 DeepSeek 官方无任何隶属、合作、授权或官方背书关系。
