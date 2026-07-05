# Research: Codex Lead 读-外泄加固 — FLY-260

**Issue**: FLY-260
**Date**: 2026-06-17
**Source**: FLY-245 design review R2 真机铁证(从 245 拆出);本 session 的真机 probe(`codex sandbox` + `codex app-server` 协议级)

---

## 1. Threat model(要堵的面)

任何 **Codex Lead** 的 exec shell 在 Codex 沙箱下运行。当前沙箱用 legacy `sandbox_mode`
(`read-only` / `workspace-write`):它**只挡写 + 网络,不挡读**。所以:

```
model 的 shell  →  cat ~/.codex-mufasa/auth.json   (读出 OpenAI 凭据)
                →  把内容塞进一条正常的 Discord 回复
                →  经 Lead 自己的出站通道发出(关 shell 网络拦不住)
```

- **不是 FLY-245 引入的**,是 Codex Lead 这个形态的固有读面。
- **不是活跃漏洞**:Mufasa 是我们自己的 agent、跑我们自己的 persona,不是对手 → 理论面。
- 但面真实存在,将来 Codex Lead 扩用 / 写权限上线前值得收紧(Annie 要的安全前置)。

---

## 2. 现状审计(代码 + 部署)

| 项 | 现状 |
|---|---|
| 在线 Codex Lead | **只有 Mufasa**(`projects.json`: growth, `backend=codex-app-server`, `companion:true`) |
| Belle | **Claude Lead**(`projects.json` 无 `backend` → claude-default)→ **无 Codex 读面**;issue 写的「Belle 同样有」**不准** |
| Mufasa 形态 | ③ TUI(`codex resume --remote` + `remote-control` daemon),CODEX_HOME=`~/.codex-mufasa`,标准/独立 0.140 |
| 沙箱来源 ① | `buildThreadParams`(`codex-lead-runtime.ts`)→ thread/start 传 `sandbox: "read-only"`(legacy) |
| 沙箱来源 ② | `codex-lead-tui-home.sh` 写 `config.toml`:`sandbox_mode="read-only"` + `approval_policy="never"`(fail-close 校验 drift) |
| 沙箱来源 ③ | `tui-window.ts buildTuiCommand`:`codex resume --remote ... -s read-only -c 'approval_policy="never"'`(R4 HIGH-4 多重 pin) |
| FLY-245 write-capable | fail-closed / 未部署;`confinement.ts assertConfinement` 硬断言 legacy descriptor(`sandbox.type==="workspaceWrite"` 等)→ 迁 profile 会动这套刚 merge 的 7 轮机器 → **本期不碰,follow-up** |

---

## 3. 真机 probe 结论(决定性)

本机 `codex-cli 0.140.0`(npm + `~/.codex-mufasa` 的 standalone 均为 0.140)。

### 3.1 干净解的机制:Codex 0.140 `[permissions]` profile 的 `filesystem deny`

Codex 0.140 引入 **named permission profiles**(`[permissions.<name>]` + 顶层
`default_permissions`),`filesystem` 支持 `read` / `write` / **`deny`**(deny **同时挡读+写**),
支持 glob。官方文档 + 真机双证:

**Probe 1 — `codex sandbox -P <profile>`(内核层 enforcement 实证)**
配置一个 `extends=":read-only"` + `filesystem."<secret dir>"="deny"` 的 profile:

```
A) cat 工作区内 public 文件   →  内容正常输出      (exit 0,ALLOWED)
B) cat 被 deny 目录的 secret  →  Operation not permitted   (DENIED)
```

→ macOS Seatbelt **内核层真挡住读**,正常工作目录照常读。

**Probe 2 — `codex app-server --strict-config`(真实部署路径)**
Codex Lead 走 app-server(headless)/ daemon(TUI),不是 `codex sandbox`。协议级 probe:

- `--strict-config` **接受** 带 `[permissions]` + `default_permissions` 的 config(不拒绝未知 key)。
- thread/start **不传** sandbox 参数 → descriptor 回显
  `"activePermissionProfile": { "id":"secure", "extends":":read-only" }` → **app-server honor 该 profile**。

### 3.2 关键坑:legacy sandbox 参数会**禁用** profile

> 官方文档:"Permission profiles do not compose with the older sandbox settings."

真机证实:

| thread/start 传参 | descriptor `activePermissionProfile` |
|---|---|
| **不传** sandbox | `{ id:"secure", extends:":read-only" }`  ✅ profile 生效 |
| 传 `sandbox:"read-only"`(当前代码所为) | **`null`**  ❌ profile 被禁用 |

→ 迁移**必须同时去掉所有 legacy sandbox 覆盖**:`buildThreadParams` 的 `sandbox` +
`tui-window` 的 `-s read-only` + `config.toml` 的 `sandbox_mode` pin。任一残留都会把
`activePermissionProfile` 打回 `null`,deny 规则失效。

---

## 4. 结论 + 决策(Annie 已批 + scope 修正,经 Lead relay)

- **方案 = 沙箱 deny**(permissions-profile,内核层 deny 读密钥)。✅ 唯一真正堵死且达验收的解。
- **范围 = 只 Mufasa**;FLY-245 write-capable 作 follow-up;Belle = Claude Lead 无此面,OUT。
- **PR-only / 零 live / founder-gated**:PR 加机制 + 测试 + 保记忆重启 runbook;**真重启 Mufasa
  是 Annie 在场的单独 gated step**(默认 OFF flag,merge 后字节兼容,cutover 时翻 flag + 重写 config + 重启)。

### 4.1 🔴 scope 修正(Annie 抓的关键):Mufasa = Codex COE Director,deny 须外科手术式

Mufasa 经 **FLY-285 升级为 Codex COE Director**(亲自协调 + 派 Runner,需用 `~/.flywheel`
comm DB + teamlead.db + bin + Bridge 编排;FLY-285 当前 In-Progress、PR #282 HELD、
`canSpawnRunners:false` → Director 能力**在途**)。→ deny **绝不能一刀切 `~/.flywheel`**,否则废掉
Director 编排。**「不破坏 COE Director 编排」= 硬设计约束 + 强制测试点。**

**外科手术 deny 清单(真机验证)** —— 不 deny `~/.flywheel` 目录,只 deny 其中密钥文件 + 专用密钥目录:

| 路径(codex 生效形式) | deny 理由 |
|---|---|
| `~/.codex**` | 所有 Codex home 的 auth.json(主外泄目标) |
| `~/.ssh` `~/.aws` `~/.config/gh` | SSH 私钥 / AWS 凭证 / GitHub token |
| `~/**/.env` + `~/**/.env.bak**` | 所有 `.env` 文件(含 `~/.flywheel/.env`)—— **文件级,不挡目录** |

真机证(`codex sandbox -P flywheel-lead-secret-deny`):`~/.flywheel/**/.env*` **DENIED**,
而 `~/.flywheel/**/comm/*`、`~/.flywheel/deployed-sha` 等 operational 路径 **ALLOWED** →
Director 编排完整保留;`app-server --strict-config` 接受 config 且 `activePermissionProfile` active。
**待 design-review/Annie 确认**:`~/.config/gh`(Director 是否 exec-shell 跑 gh)、`~/.codex**`
(Director 是否 exec-shell `exec codex` 而非经 Bridge 派 Runner)—— 预期都不需要,需确认。

被否的两个备选(供留档):
- **出站回复扫描打码**:模型能换写法/拆分/编码绕过,只挡 Discord 一个出口(挡不住 web_search),误伤正常内容 → 治标。
- **收窄密钥面(FLY-246)**:不关闭「读」面(Lead 自己的 auth.json 仍在盘上且可读)→ 不满足验收;归 FLY-246 减小爆炸半径。

---

## 4.2 最终设计补充(codex design review R1→R3 后,全部真机验证)

R1/R2/R3 review 又补出几条(都已并入 plan + 实现):

- **env 也是平行外泄面**:legacy/TUI 路径不洗 env,model exec shell `printenv MUFASA_BOT_TOKEN` 仍泄。修=config 顶层 `[shell_environment_policy] exclude=["*TOKEN*","*SECRET*","*KEY*"]`(真机:UPPER 形式即隐藏小写 `fly260_lower_token` → **glob 大小写不敏感**,无需小写变体)。仅 token 形,不一刀切 `FLYWHEEL_*`(保编排 env)。
- **长驻 daemon 不重读 config**:`codex remote-control` daemon 在 start 时读 config;flag-on 改 config 后必须 `remote-control stop` 再 start(已验证 stop 存在)。flag-off 保幂等 start(字节兼容)。
- **`.env` 家族**:`~/**/.env**` 真机覆盖 `.env`/`.env.local`/`.env.production`/`.envrc`/`.env.example` + **单层** `~/<dir>/.env`(= `~/.flywheel/.env` 形状),不碰 operational 兄弟文件。
- **主机凭据清查(names-only)**:present 且加入 deny = `~/.npmrc`、`~/.docker`、`~/.config/gcloud`;absent(片段注释记录)= `~/.netrc`/`~/.git-credentials`/`~/.kube/config`/`~/.gnupg`/`~/.pgpass`/`~/.gem/credentials`。
- **resume profile 回显不可在无-auth 环境确证**(turnless thread 无 rollout)→ runtime 用 **ephemeral throwaway `thread/start`**(非 model turn,可靠回显)作 boot 前置硬门证明 daemon 的 `default_permissions` 已生效,fail-closed 在启 gateway 前;runbook cutover 在真 thread 上再以「真 `cat auth.json` 被拒」兜底。
- **gh/codex = 明确设计契约**(非待确认):Director 经 `~/.flywheel`+Bridge 编排,**不依赖 exec-shell `gh`/`codex`**;故 `~/.config/gh` + `~/.codex**` 保留 deny。
- **接受残留可读**:`~/.flywheel/codex-teams`、`cipher.db`(operational/data 非凭证);更广隐私读隔离若 Annie 要 = 单独 follow-up。

最终有效清单(committed 真机测试 `fly260-read-deny-enforcement.test.sh` 20/20 验证):filesystem deny = `~/.codex** ~/.ssh ~/.aws ~/.config/gh ~/.config/gcloud ~/.npmrc ~/.docker ~/**/.env**`;env exclude = `*TOKEN* *SECRET* *KEY*`;**不 deny `~/.flywheel`**。

## 5. 风险 / 未决(交给 plan + QA)

1. **deny 清单广度**:太宽会误伤 companion 合法读;清单已限定为凭据目录。`~/.codex*` 是 glob
   (覆盖所有 per-Lead home);`**/.env` 覆盖任意 `.env`。需真机验证 glob + `~` 展开形式被 codex 接受。
2. **TUI `codex resume --remote` 去掉 `-s` 后**:resume 的 thread 是否仍保持 `activePermissionProfile`
   非 null(founder 的 client 与 sidecar 共享同一 thread 的沙箱)→ 真机验证。
3. **零 live 的部署顺序风险**:Mufasa 现有 config 是旧 `sandbox_mode` pin;merge 后若 launchd 重启跑
   ensure-home 不能 fail-close 把 Mufasa 弄下线 → 用 **默认 OFF 的 `FLYWHEEL_CODEX_LEAD_READ_DENY`
   flag** 把「新 config 形态 + runtime 去 legacy sandbox + TUI 去 `-s`」三处统一门控,merge 字节兼容。
4. **真 enforcement 验收**(shell 真读不到 auth.json)= Annie 在场的 cutover gated step;PR 内用**隔离测试
   CODEX_HOME**(非 Mufasa 真 home、无真凭据)复现 probe 作为可重跑证据。
