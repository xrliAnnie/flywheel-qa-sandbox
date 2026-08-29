# FLY-260 — Mufasa read-deny cutover runbook

**Issue**: FLY-260
**Date**: 2026-06-17
**Status**: NOT auto-executed — this is the **founder-present, single gated step** that turns the
read-deny hardening ON for the live Mufasa Codex Lead. The PR itself is **zero-live** (default-OFF
flag); merging it changes NOTHING until this runbook is run with Annie present.

---

## 0. 前提与背景

- 加固机制默认关:`FLYWHEEL_CODEX_LEAD_READ_DENY` 未设 = 字节兼容,Mufasa 跑现状(legacy `sandbox_mode=read-only` pin)。
- 本 cutover = 给 Mufasa 的启动环境置 `FLYWHEEL_CODEX_LEAD_READ_DENY=1` + 重写 config + 重启,使其 exec shell 在内核层读不到凭据(`~/.codex*` auth.json / `.ssh` / `.aws` / gh / gcloud / npm / docker / 任意 `.env*`)+ 不能 `printenv` token,同时**保留** COE Director 经 `~/.flywheel`(comm DB / teamlead.db / bin / state)+ Bridge 的编排能力。
- Mufasa = ③ TUI Codex Lead,CODEX_HOME=`~/.codex-mufasa`,state dir=`~/.flywheel/state/codex-lead/mufasa-lead`,launcher=`~/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui.sh`。
- **记忆延续铁证 = thread-id**:`<stateDir>/thread-id`。cutover 前后必须逐字一致(同 state dir → resume 同 thread)。

## 1. 执行前快照(留证)

```bash
# thread-id (记忆延续基线) + 现有 config 备份
cat ~/.flywheel/state/codex-lead/mufasa-lead/thread-id        # 记下,cutover 后比对
cp ~/.codex-mufasa/config.toml ~/.codex-mufasa/config.toml.pre-fly260.bak
```

## 2. 翻 flag(给 Mufasa 启动环境)

把 `FLYWHEEL_CODEX_LEAD_READ_DENY=1` 加到 Mufasa 的启动环境(launcher/wrapper 或 `~/.flywheel/.env`,取 Mufasa 实际读取处)。**仅给 Mufasa**(growth/mufasa-lead),不影响别的 Lead。

## 3. 重写 config + 重启 daemon(关键顺序 — Codex R2-B2)

```bash
# (a) 重写 config 为 read-deny profile(原子;保留 trusted [projects];无 sandbox_mode)
FLYWHEEL_CODEX_LEAD_READ_DENY=1 \
  FLYWHEEL_CODEX_TUI_HOME=~/.codex-mufasa \
  FLYWHEEL_CODEX_TUI_CWD=~/Dev/growth \
  /bin/bash <main-repo>/packages/teamlead/scripts/codex-lead-tui-home.sh ensure-home

# (b) 让长驻 daemon 重读新 config —— 必须 stop+start(幂等的 start 不会重读!)
FLYWHEEL_CODEX_LEAD_READ_DENY=1 \
  FLYWHEEL_CODEX_TUI_HOME=~/.codex-mufasa \
  /bin/bash <main-repo>/packages/teamlead/scripts/codex-lead-tui-home.sh ensure-daemon
```

> ⚠️ `ensure-daemon` 在 flag-on 下每次都会 stop+start daemon → 重启瞬间会短暂打断 founder 的 TUI 窗口;TUI runtime 的 liveness loop(~20s)会自动重建。这是 read-deny 的预期行为(daemon 必须重读 config)。

```bash
# (c) 重启 Mufasa TUI sidecar(launchd 受管)→ 同 state dir → resume 同 thread
launchctl kickstart -k gui/$(id -u)/com.flywheel.lead.growth-mufasa-lead
```

## 4. 验收(全部必须 PASS 才算 cutover 成功)

1. **boot 门**:Mufasa 启动日志无 `FLY-260 read-deny gate … Refusing to start`(ephemeral-start 断言通过 = daemon 的 `activePermissionProfile` 生效)。
2. **enforcement 铁证**(在 Mufasa 的 TUI / exec shell 里实跑):
   - `cat ~/.codex-mufasa/auth.json` → `Operation not permitted`(读不到自己的凭据)
   - `env | grep -i token` → 无 token 值(env 已洗)
3. **🔴 COE Director 编排自检**:Mufasa 经 exec shell 能读 `~/.flywheel/comm/...`、`~/.flywheel/teamlead.db`,且能经 **Bridge** 起/查 Runner;**确认不依赖 exec-shell `gh` 或 exec-shell `codex`**(§设计契约)。
4. **persona + round-trip**:#mufasa 真聊一轮,Mufasa 回话正常、persona 在(温暖陪练腔,非工程腔)。
5. **记忆延续**:`cat ~/.flywheel/state/codex-lead/mufasa-lead/thread-id` 与步骤 1 的值**逐字一致**;Mufasa 能记得 cutover 前的对话上下文。

## 5. Rollback(任一验收失败)

```bash
# 撤 flag(从 Mufasa 启动环境移除 FLYWHEEL_CODEX_LEAD_READ_DENY)
cp ~/.codex-mufasa/config.toml.pre-fly260.bak ~/.codex-mufasa/config.toml   # 还原旧 config
FLYWHEEL_CODEX_TUI_HOME=~/.codex-mufasa /bin/bash <main-repo>/packages/teamlead/scripts/codex-lead-tui-home.sh ensure-daemon  # flag-off: start only
launchctl kickstart -k gui/$(id -u)/com.flywheel.lead.growth-mufasa-lead
```
回到 legacy `sandbox_mode=read-only` 现状(字节兼容)。

## 6. 收尾

- cutover 成功后:记录 thread-id 前后一致 + enforcement 截图(真 cat 被拒)留证。
- 关联:FLY-267 cross-dept env 是否一并补、FLY-285 Director 将来 `extends :workspace` 的写权限扩展 —— 到那时再单独定(不在本 cutover 范围)。
- write-capable Codex Lead(FLY-245)的 read-deny = follow-up(其 confinement 断言依赖 legacy descriptor)。
