# FLY-2598 主机激活与回滚清单 — 实施计划
Issue: FLY-2598 (https://linear.app/geoforge3d/issue/FLY-2598/语音激活-主机激活-2446-通用语音进程会议模式-随身模式注册表-huddle-块-lead-voicemodes-voice)
日期: 2026-09-15
基于: plan.md

执行者：Engineering Lead。此文是实现后的运行手册；`voice-host-configure.mjs`、`install-voice-launchd.sh` 已在实现分支完成本地测试，生产尚未执行。代码未合入/未由独立 updater 部署，不进入主机步骤。此手册没有批准 merge/deploy/restart，既有授权与窗口仍适用。

## 0. 冻结本次对象
- 固定生产 checkout `/Users/xiaorongli/Dev/flywheel`，实际部署 sha 另核；不能从 runner worktree 启动服务。
- General：guild 1485787271192907816 / channel 1485787273193853170。
- 首场目标 flywheel/flywheel-eng-lead；bot ID 从当前 registry 读并核 /users/@me，不能把本设计快照当未来 authority。
- 收据目录：`~/.flywheel/voice/activation/FLY-2598-<UTC timestamp>` 0700；不放 secret 或整份进程 env；配置备份也只在本机私有目录，不提交 Git。
- 无未完登记 recovery intent；summary-registry 核验通过；无活动语音会话。旧 `com.flywheel.voice-bridge` 未加载；若 `com.xrli.raya.voice` 运行且占 General，交 Raya/Lead 做已有切换，不能自行启第二服务。

```sh
cd /Users/xiaorongli/Dev/flywheel
umask 077
VOICE_ACT_DIR="$HOME/.flywheel/voice/activation/FLY-2598-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$VOICE_ACT_DIR")"
git rev-parse HEAD
cat "$HOME/.flywheel/deployed-sha"
launchctl print gui/501/com.flywheel.voice
launchctl print gui/501/com.flywheel.voice-bridge
launchctl print gui/501/com.xrli.raya.voice
node packages/flywheel-comm/dist/index.js summary-registry verify-activation \
  --projects-file "$HOME/.flywheel/projects.json" \
  --receipt-file "$HOME/.flywheel/state/summary-registry/migration-receipt.json"
```
三个 print 的 absent 是初装基线；不把其非零输出藏掉。部署 sha/build identity 与目标版本不相符：暂停此 runbook，等待正确部署；不自行 restart-services。

## 1. 准备与应用配置
```sh
node scripts/voice-host-configure.mjs prepare --out "$VOICE_ACT_DIR"
node scripts/voice-host-configure.mjs apply --receipt "$VOICE_ACT_DIR/receipt.json"
node packages/teamlead/dist/bin/validate-projects.js "$HOME/.flywheel/projects.json"
node packages/flywheel-comm/dist/index.js summary-registry verify-activation \
  --projects-file "$HOME/.flywheel/projects.json" \
  --receipt-file "$HOME/.flywheel/state/summary-registry/migration-receipt.json"
stat -f '%Lp %N' "$HOME/.flywheel/voice-host.json"
```
prepare 创建全新的0700目录（不要预先创建 `$VOICE_ACT_DIR`），输出 id/status、scope、hash、receiptPath，不输出原始配置或凭据；Lead 核所有现有项目同房、全部现有 Lead meeting=true、仅 raya/raya rg=true、其他字段未变；保留已有合法 realtimeVoice，缺席设 marin。apply 自动重取同一 cfglock，检查所有前像，原子替换；任一冲突停止，不重试覆盖。验收：schema通过、summary verify `ok:true`、receipt hash不变、voice-host 600。这里不调用 register/migrate，也不增删 Lead。

## 2. 专用 API 运行目录
先核 wrapper 真正读取的 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/.env`，不能用当前交互 shell 的 key 存在性代替。当前设计只读探测已看到 `export OPENAI_API_KEY=...`，但激活时必须重新执行下面的 clean-source 检查。只输出布尔及模式，不输出值或整份环境。
```sh
stat -f '%Lp %N' "$HOME/.flywheel/.env"
env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash --noprofile --norc <<'BASH'
set -e
set -a
source "$HOME/.flywheel/.env" >/dev/null 2>&1
set +a
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  echo 'daemonSourceKeyPresent=true'
else
  echo 'daemonSourceKeyPresent=false'
  exit 1
fi
BASH
```
若主机配置使用非默认 state dir，上述 path 必须跟实际 plist/wrapper 解析值一致。env 文件须为本人拥有的普通文件、0600。若 clean-source 返回 false：Lead 在本机受信终端编辑这个文件，加入一条 `export OPENAI_API_KEY='<平台 key>'`（示例占位符不得写入），使用真实平台 key，保持其他配置不变并 chmod 600；用安全本地输入取得 key，禁止通过聊天、argv、终端回显或 Git 传值。若已有非空 key 则保留，不轮换。再次 clean-source 通过才继续；没有 key 则明确记未执行并停止激活。这是凭据 provisioning 步骤，设计 Runner 没有执行它。
```sh
node --input-type=module <<'JS'
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dir=join(homedir(),'.flywheel','voice','codex-home');
const content='forced_login_method = "api"\ncli_auth_credentials_store = "ephemeral"\n';
if(existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw Error('voice_home_unsafe');
mkdirSync(dir,{recursive:true,mode:0o700});
if((lstatSync(dir).mode & 0o777)!==0o700) throw Error('voice_home_mode');
const cfg=join(dir,'config.toml');
if(existsSync(cfg)) {
  if(lstatSync(cfg).isSymbolicLink() || readFileSync(cfg,'utf8')!==content || (lstatSync(cfg).mode&0o777)!==0o600) throw Error('voice_home_config_conflict');
} else writeFileSync(cfg,content,{mode:0o600,flag:'wx'});
console.log('voice home ready; no credential copied');
JS
codex --version
```
遇现有文件不覆盖，也不 logout/轮换全局或 Lead 账号。实际认证是每次前台 API login/read 的 type=apiKey；home准备不代表已认证。账号余额由 founder 看；401/模型拒绝/余额失败记真实失败，不引用订阅 quota。

## 3. 让运行进程消费新配置
Bridge projects/voice-host 在启动时读取，voice daemon同样如此。必须由 Lead 把配置生效请求交既有独立 updater 的已授权窗口；验部署收据、Bridge build identity/启动时间、目标配置 digest。未收到载入新配置的证据，不启动首场。单纯文件 hash 或 CLI --check-config 不证明 Bridge 已载入。
若本次 code部署先于写配置，此处还需一次授权配置加载窗口；不要反复向 founder 要新权威，也不要手动越过已有窗口机制。该步骤没有一个可由 design Runner 执行的 restart 命令。

## 4. 身份与权限只读预检
按每个注册 Lead 的 botTokenEnv 在已加载 env 内取凭据，调用 Discord GET：`/users/@me`、`/guilds/<guild>/members/<bot>`、`/guilds/<guild>/roles`、General 和 chatChannel；使用 `preflightVoiceSession` 同一逻辑（`scripts/qa/fly2598-voice-preflight.mjs` 与生产共用，不写第二套权限算法）。报告只有 public ID、permission booleans或null、HTTP状态/stage/reason，不含 header；GET403 时无法计算的权限写 null。
```sh
node scripts/qa/fly2598-voice-preflight.mjs --project flywheel --lead flywheel-eng-lead \
  --out "$VOICE_ACT_DIR/flywheel-eng-lead-permissions.json"
```
入口只读取本机 projects.json、0600 voice-host.json 和0600 .env；.env只解析静态赋值，不执行shell展开。--out须为不存在的新文件，0600独占创建；现有文件和symlink拒绝覆盖。退出0表示该Lead本次预检通过，退出1需查reason/stage；本地配置错误只输出固定错误，不输出原始配置。

全部Lead的矩阵应按prepare冻结的project/lead清单逐个运行相同命令，不以第一个通过外推。每行还必须带 self-filter 运行探测收据（contractVersion、runtimeId、botId、ready/selfDropped/unknownDropped/otherPassed 布尔全部满足 self-filter-contract.md）。fork 源码/check-discord-plugin.sh 成功或静态文件存在均不替代探测。旧载体缺能力：该 Lead 未就绪；由既有受管载入窗口加载配套插件，不通过生产进房来测试过滤，不擅自重启生产 Lead。

founder 给角色 Connect/Speak；仍需 VIEW_CHANNEL 和文字串权限并集。某 Lead 权限缺失只标该 Lead未就绪，不能谎称“所有 Lead ready”。不邀请 alerts bot，不让生产 Lead 进房当权限探针。既有 CLI没有 preflight-only，因此增加的 QA调用必须直接调用只读 helper，绝不合法 POST start 假装预检。

Bridge阶梯保存每行 `{case,time,status,error,reason,executed}`：
| 请求 | 预期 |
|---|---|
| GET /api/voice/sessions/<不存在UUID>，无/坏 bearer | 401；master真的未配置则503 |
| 同路径 master | 404 voice_session_not_found |
| POST /api/voice/sessions，master，body={} | 400 voice_request_invalid |
| POST start，master，rg + 显式不存在的 Lead | 404 lead_not_found |
| GET /api/voice/sessions/desired，ingest | 403；缺 ingest 标未执行 |
| GET /api/voice/sessions/desired，master | 200（desired可为空）；若有会话先处理它，不激活第二场 |

不要清生产 master 来制造503。合法 start通过预检后立即 reserve+发根卡/thread，是有副作用操作；在首场前不执行。权限失败/room缺失等生产没有命中时由隔离测试证明，现网列未执行。
旧 `/api/voice/{scope,context,gate-binding,ship-approval}` 不是新 sessions middleware，不把它们混入本阶梯。

## 5. 安装与守护进程证明
```sh
bash scripts/install-voice-launchd.sh --check
bash scripts/install-voice-launchd.sh
launchctl print gui/501/com.flywheel.voice
bash -c 'source scripts/lib/supervisor.sh; supervisor_assert_keepalive voice on-failure'
tail -n 60 /tmp/flywheel-voice.log
```
必须 running+PID、实际 wrapper路径、SuccessfulExit=false；记录一段观察窗中无反复退出/启动。exit0可能是wrapper拒绝启动，不是成功。manifest保留hold，不改managed；census仅辅助清单检查。hold 不检测源/装机 plist 漂移，也不会拉回被 bootout 的 job。Engineering Lead 每次激活/部署后及既有主机巡检运行 --check、`cmp scripts/launchd/com.flywheel.voice.plist "$HOME/Library/LaunchAgents/com.flywheel.voice.plist"` 和 print，异常报告后由既有授权窗口处置。
不要运行 `flywheel-comm voice-session status` 裸命令；它没有全局 daemon状态。

## 6. 第一场 General 会议
平台 key已备、只读预检含运行过滤证明通过、founder在场且愿意试一句后；先记 GET /gateway/bot 的 session_start_limit，voice 与 carrier 分开启动。场内观察两者 online/close code，不能以 voice ready 代替 carrier 健康；若 carrier 异常立即结束本场：
```sh
mkdir -p "$HOME/.flywheel/voice/evidence/FLY-2598-first-meeting"
node packages/flywheel-comm/dist/index.js voice-session start \
  --mode meeting --project flywheel --lead flywheel-eng-lead \
  --evidence-dir "$HOME/.flywheel/voice/evidence/FLY-2598-first-meeting" \
  --topic 'FLY-2598 General 首场验证' --json
```
从返回 JSON 精确取 sessionId，记录为 `VOICE_SESSION_ID`；失败不可凭猜测填 ID。后续：
```sh
node packages/flywheel-comm/dist/index.js voice-session status --session "$VOICE_SESSION_ID" --json
node packages/flywheel-comm/dist/index.js voice-session stop --session "$VOICE_SESSION_ID" --json
node packages/flywheel-comm/dist/index.js voice-session status --session "$VOICE_SESSION_ID" --json
```
先等 live再说测试句，例如“请把我刚说的话简短复述一次”。收据必须同一session串起来：
1. Discord截图：General里 bot=本场Lead，只一个Lead，founder在场；文字串里的🗣️镜像+正常Lead回复（message链接/ID）。
2. voice_sessions 行：session/project/lead/guild/channel/voice_bot_user_id/thread/state时间；不导出 lease token。
3. voice delivery：镜像messageId、founder authorId、deliveryId、source_kind=voice、消费证据；`message-status <精确id> --with-envelope` 验同一tuple（遇CLI语法变化先 --help/source核）。
4. voice_outbound：Lead作者、messageId、phase与本次attempt对应；不公开完整lease/attempt凭据。
5. founder听到的实际回复，配截图与房内音频片段/波形；确认镜像/状态/前台自言未被循环朗读。ACKED和confirmed分别只是传输/匹配证据，不能代替声音。
6. 退出口令或stop后ended，bot离房，活跃行数=0；voice daemon仍 idle running。

DB只做readonly参数化SELECT或使用受管snapshot；要复制 live teamlead.db/comm.db必须 `node scripts/flywheel-snapshot-control.mjs runner ...`，遵循该命令help和本exec目录/2GB限制，不cp。停止/关闭句柄再交接。
这是本单运维首场，meetingId可能空；原2446完整经Raya adapter两种harness会议不能拿这场替代。

## 7. RG单独验收
仅当Raya载体、权限、API接线已就绪：
```sh
node packages/flywheel-comm/dist/index.js voice-session start \
  --mode rg --project raya --lead raya --topic 'FLY-2598 随身验证' --json
```
以这次独立sessionId重复status/stop与证据链，用耳机真实说一句和听回复，确认会议线程与Raya chatChannel的绑定/朗读符合既有RG规则。未完成则写“RG未执行：<具体缺项>”，不回填meeting的截图。其他Lead rg=false的403由隔离测试证明，不为了测试给生产Lead临时开关。

## 8. 回滚
1. 精确当前session stop，等待ended/cancelled/failed与离房证据；stop失败则按lease/超时处理，不在活跃音频时恢复身份字段。
2. `bash -c 'source scripts/lib/supervisor.sh; supervisor_stop voice service'`，核 job/PID不存在；不kill其他Lead。
3. `node scripts/voice-host-configure.mjs restore --receipt "$VOICE_ACT_DIR/receipt.json"`，只在所有文件仍属本次前后像时恢复；冲突由Lead处理，不覆盖第三方新注册。复验summary同一receipt。
4. 只有安装收据证明目标plist为本次新建、hash/inode未变、job已卸载时删除；原有文件保留。专用voice home可留0700，不删journals/evidence。
5. 配置新字段已撤后才安排软件回滚；代码回滚仍是独立updater工作。明确记录未恢复旧Raya/编排voice，不自动切回已废除方案。

## 9. 目前验收状态
本设计节点只做源码审计与 prechange-http-evidence.json 的无副作用探测。代码、fixture测试、新安装器、主机配置写入、API握手、权限全矩阵、会议首场、RG：全部未执行。正式完成需实现/QA/Lead逐项替换为具体证据，不能批量勾选。
