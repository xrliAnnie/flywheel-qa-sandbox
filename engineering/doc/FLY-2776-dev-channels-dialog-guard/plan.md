# FLY-2776 dev-channels 确认框守卫失效 — 实施计划

Issue: FLY-2776 (https://linear.app/geoforge3d/issue/FLY-2776/lead-启动确认框守卫失效-claude-code-升级后-dev-channels-确认框文案变了claude-leadsh-的-dev)
日期: 2026-09-22
基于: research.md
评审: design-feedback-round1.md(独立 fresh-context 评审 —— Codex 配额耗尽、Gemini IneligibleTierError,
      按 FLY-2770 先例 + Lead 指令 ccd2a2ac 走 subagent 评审 + leadAcceptance)。本文档为 round-1 之后的定稿。

## 0. 一句话

守卫不是被「新文案」骗了,是被 **49x16 的视口**骗了 —— 标题滚出屏幕、提示句被
折行,`grep -qF` 整句失配。判据改成**三类互相独立、缺一不可**的证据:行锚定的选项行
(结构)、模态底栏在屏且 Claude composer 不在屏(模态)、归一化后的正文句(语义);
并把「部分命中」从静默放弃升级成响的告警,连 43x16 / 30x16 这种连选项行都折了的真框
也不再静默。

## 1. 改动清单

| # | 文件 | 改什么 |
|---|---|---|
| C1 | `packages/teamlead/scripts/claude-lead.sh` | 新增 `_dev_channels_squash_ws`;重写 `_dev_channels_dialog_present`(结构 + 模态 + 语义三类证据) |
| C2 | 同上 | NOT_SEEN classification 改用归一化文本 + 新增 `match_dangerously` / `match_option_row` / `match_option_squashed` / `match_modal_footer` / `match_live_prompt` / `geom`;新增 `_dev_channels_drift_alert` 与三通路 + 一票否决的漂移判定 |
| T1 | `scripts/__tests__/fly1679-dev-channels-v2.test.sh` | P1–P7 不动;新增 P8–P18(真实 capture);T4b 重新对齐;新增 T4c |
| T2 | `scripts/__tests__/fly2776-dev-channels-geometry.test.sh`(新) | F/G/M/A/H 五层 |
| T3 | `.github/workflows/ci.yml` | 把新套件挂进既有 step |
| D1 | `engineering/doc/milestones/FLY-2776.md` | 里程碑,**literal last commit** |

不动:按键逻辑(实测仍正确)、`lead-alert.sh`(复用既有 kind,零新增登记)、
carrier / launchd / pane 几何 / 生产 Lead。

## 2. C1 — 判定式

### 2.1 环境事实(评审实测,决定了下面每一个写法)

启动器**没有 locale**:Lead 的 plist 只设 `FLYWHEEL_LEAD_MODEL`,`launchctl getenv LANG`
为空,`flywheel-lead-wrapper-v2.sh` 与 `claude-lead.sh` 都只在已设置时转发 locale。
于是生产环境跑的是 **C locale**。后果:

* BSD `sed`/`grep` 的**方括号表达式 `[│┃|]` 在 C locale 下是字节集合**
  `{E2,94,82,83,7C}` —— 而 `│`、`┃`、`❯` 的首字节都是 `E2`。用方括号剥边框会把
  `❯` 自己咬掉一个字节。评审实测:locale 未设时 P1/P8/P9 三个 present 用例**全红**
  (含 P1 —— 今天还能工作的用例),`LANG=UTF-8` 时 13 个全绿。
  **绿在每一台开发机、绿在 CI、死在生产。**
* 因此:所有匹配一律 `LC_ALL=C` 钉死(pane capture 可能含任意字节,UTF-8 locale 下
  BSD grep 遇到非法多字节序列会直接报错);多字节字符一律写成**字面量或 ERE 交替**,
  绝不进方括号。

`set -o pipefail` 的坑同样要具体:`sed … | grep -q` 里 `grep -q` 短路会 SIGPIPE 掉
上游,管道状态变成 **141**,即使 grep 命中了也会被读成「没命中」。套一层普通子 shell
**没用**(状态照样 141)。本文件既有注释已经给了正确答案:**只用 here-string 和
命令替换,不出现管道。**

### 2.2 实现

```bash
_dev_channels_squash_ws() {
  local unframed=""
  unframed="$(LC_ALL=C sed -e 's/│/ /g' -e 's/┃/ /g' <<<"$1")"
  LC_ALL=C tr -s '[:space:]' ' ' <<<"$unframed"
}
```

两步,顺序不能换:先把竖线边框折成空格,再把所有空白(含换行)压成单空格。
只做第二步不够 —— **带边框且又折行**时,边框正好落在句子两半中间
(`…run a list of │` / `│ approved channels.`),压空白永远拼不回来。无边框的
2.1.280 渲染不需要第一步,fly1679 的 `REAL_DIALOG` 带边框的渲染需要,两种形状在本仓
的证据里都存在。

```bash
_dev_channels_dialog_present() {
  local text="$1" squashed="" feature="" option_row_re="" footer_re=""
  local -a body_features=()
  option_row_re='^[[:space:]]*(│[[:space:]]*)?(❯[[:space:]]+)?1\.[[:space:]]+I am using this for local development[[:space:]]*(│[[:space:]]*)?$'
  body_features=(
    'WARNING: Loading development channels'
    'Please use --channels to run a list of approved channels.'
    '--dangerously-load-development-channels is for local channel development only.'
  )
  footer_re='Enter[[:space:]]+(to[[:space:]]+)?confirm'

  LC_ALL=C grep -qE "$option_row_re" <<<"$text" || return 1          # 必需 1 结构

  squashed="$(_dev_channels_squash_ws "$text")"

  LC_ALL=C grep -qE "$footer_re" <<<"$squashed" || return 1          # 必需 2a 模态底栏
  if LC_ALL=C grep -qF -e '⏵⏵' <<<"$text"; then                      # 必需 2b 无 composer
    return 1
  fi

  for feature in "${body_features[@]}"; do                            # 必需 3 语义
    if LC_ALL=C grep -qF -e "$feature" <<<"$squashed"; then
      return 0
    fi
  done
  return 1
}
```

> 这一段是**归档的可执行合同**,必须和 `claude-lead.sh` 逐字一致。少写 `footer_re` 或
> 少写 `⏵⏵` 那一条,就是把 round-2 代码评审 BLOCKER 1(整块转述被当活框)原样放回去。

要点:

* **必需 1(结构)**:选项 1 必须**独占一行**。活着的框里它是一行;转述这个框的
  对话里它在行中(fly1679 的 P4 正是这个形状,本 issue 自己的 Discord 讨论是另一个)。
* **必需 2(模态)**:行锚定挡得住「行内引用」,挡不住「整块粘贴」—— 而本仓的
  exploration.md 和 fixture 现在就逐字含着那一整块,Lead 迟早会把它渲染出来。
  两个条件把这个窗口关掉:
  * 模态底栏 `Enter (to )?confirm` 必须在屏(活 Select 才会打它);
  * Claude 的输入框指示符 `⏵⏵` 必须**不**在屏 —— 框是模态的、会挡住 composer,
    所以真框在屏时不可能同时有它;而普通 Lead 屏幕上它永远在。
  两条都是 fail-safe 方向:未来 Claude 去掉底栏或把指示符和框一起渲染,守卫会
  拒按,而自本单起拒按不再静默(见 §3.2)。
* **光标 `❯` 可选**。它是「option 1 被聚焦」的强证据,但强制要求它,等于让未来某个
  把焦点放在别处、或换了光标字形的 Claude 版本**一次性放倒全舰所有 Claude 载体的
  Lead**。去掉它不损失排他性 —— 挡住转述的是行锚定,不是光标(P4/P12 都带光标,
  都在行中)。
* **必需 3(语义)**三选一,归一化后匹配。宽 pane 由标题满足,49x16 由提示句满足;
  只认某一句就等于在另一个几何下重造这个 bug。
* `grep -qF` 匹配以 `--` 开头的模式**必须写 `-e`**,否则被当成选项、`rc=2`,那条
  分支变成死代码。
* 三条**都**必需,来自框的不同区域,互不蕴含 —— 满足「至少两段互相独立的特征文字」。

### 2.3 残余风险(登记,不隐瞒)

1. **pane < 44 列 → 不按键**。`  ❯ 1. I am using this for local development` 正好 44 列。
   实测当前 2.1.280:
   * **43x16** → `❯ 1. I am using this for local` / `     development`
   * **30x16** → `❯ 1. I am using this for` / `     local development`(底栏也折)
   两种下必需 1 都失配 → 守卫**不按**。这是刻意的 fail-safe:行折了就无法确定这个
   标签属于哪一行,往活着的 prompt 里乱打字比不按更糟。44 这个数字写进代码注释。
   **但不按不等于不吭声** —— 这两种几何都会命中 §3.2 的第三条通路并发漂移告警。
   (这一条是设计评审 round-2 / 代码评审 BLOCKER 2 抓出来的:第一版的告警门槛在
   43x16 和 30x16 下都不响,和「不再静默」的承诺直接矛盾。)
2. **整块渲染**:必需 2 的两个模态条件(底栏在屏 + `⏵⏵` 不在屏)已经把这个窗口
   收得很窄 —— 一个**正在收信**的 Lead 屏幕上永远有 `⏵⏵`。残余的是「屏幕上既有
   整块 capture、又没有 composer」的情况(比如 pane 刚启动、composer 还没画出来时
   恰好在重放一段含全文的 transcript)。代价有界:send-keys 只发 `1`、永不发 Enter,
   最坏输入框里多一个 `1`,不会提交。**接受并登记。**

## 3. C2 — 可观测性

### 3.1 classification

NOT_SEEN 的 classification 原本逐条 `grep -qF` **原始** capture,窄 pane 下自己也被
折行骗 —— 这正是它报出 `match_warning=0 match_channels_hint=0`、把根因带偏一整天的
原因。改成对归一化文本算,并补两个新字段:

```
lines=<n> geom=<WxH> blank=<bool>
match_warning=<0|1> match_local_dev=<0|1> match_channels_hint=<0|1>
match_dangerously=<0|1> match_option_row=<0|1> match_option_squashed=<0|1>
match_modal_footer=<0|1> match_live_prompt=<0|1>
banner_channels=<0|1> prompt_caret=<0|1> pane_sha256=<digest>
```

这一行被 fly1679 的 T4b 按字节钉死,顺序和字段名都是合同的一部分。

* `match_option_row` —— 判定式的结构那一半,单独上报。有了它,日志才第一次能分清
  「框在屏上、但结构特征没认出来」和「压根没弹框」。
* `geom` —— 这次事故真正需要的那一个字段。有它,49x16 是**五分钟**的诊断。

### 3.2 漂移判定(不是「命中任一」)

```bash
semantic_hits=$((match_warning + match_channels_hint + match_dangerously))
if [ "$match_live_prompt" -eq 0 ] \
  && { [ "$match_option_row" -eq 1 ] \
    || [ "$semantic_hits" -ge 2 ] \
    || { [ "$match_option_squashed" -eq 1 ] && [ "$match_modal_footer" -eq 1 ]; }; }; then
  _log_startup "... DEV_CHANNELS_SUSPECTED_DRIFT ${classification}"
  drift_shape="${match_option_row}${match_option_squashed}${match_modal_footer}${match_warning}${match_local_dev}${match_channels_hint}${match_dangerously}"
  _dev_channels_drift_alert "$drift_shape" "$classification"
fi
```

> 同样是可执行合同。漏掉第三条通路 = 43x16/30x16 的真框重新变回静默;漏掉
> `match_live_prompt` 那一票否决 = 本仓提交的这份 capture 会 page 全舰每一个渲染过它的 Lead。
> shape 是 **7 位**,不是 5 位。

**不能**用「四个 flag 命中任一」。`I am using this for local development` 是选项
**标签**,Lead 在 Discord 里聊这个 flag 就会把它印在屏幕上 —— fly1679 的
`TRANSCRIPT_A_PLUS_B` 正是这种屏幕,而 Aunt Cass 报这个事故的时候屏幕上就是它。
那样每次冷启都会 page 一次。

三条通路,每一条都是转述没有的形状:

| # | 条件 | 抓的是 |
|---|---|---|
| a | `match_option_row=1` | 选项行独占一行地渲染着、我们却没敢按 —— 真正危险的状态 |
| b | `semantic_hits >= 2` | 两句独立正文同时在屏(转述很少逐字带两句,真框永远三句齐全) |
| c | `match_option_squashed=1 && match_modal_footer=1` | **< 44 列的真框**:行折了 a 落空、正文只剩一句 b 也落空,靠「折行后的标签 + 模态底栏」兜住 |

**一条一票否决**:`match_live_prompt=1`(屏上有 `⏵⏵`)时一律不告警。这条告警的语义
是「某个 Lead 卡在框上收不到信」;而屏幕上有 composer 的 pane **就是在收信**。此时
上面任何一条命中,都说明那是它**自己渲染出来的东西**(一份文档、一段 transcript、
本单的 exploration.md),不是它被困在后面的东西。没有这一票否决,把 capture 提交进
仓库这件事本身就会 page 全舰每一个显示过它的 Lead。

### 3.3 告警

```bash
_dev_channels_drift_alert <shape> <classification>
  → ${LEAD_ALERT_SH:-${FLYWHEEL_ROOT}/scripts/lead-alert.sh}
    --strict-delivery                      # ← 回执必须解析,退出码不够用
    --kind external_config_error --severity warning
    --title "dev-channels dialog on screen but not auto-confirmed"
    --body  "<项目/Lead> … 手工按键 + 查 startup.log 和 _dev_channels_dialog_present … Classification: <classification>"
    --signature "dev-channels-drift-<shape>-<UTC YYYYMMDD>"   # ← 形状 + 日桶
  verdict=<stdout 最后一行>
    sent|duplicate|queued_transient           → DRIFT_ALERT_SENT
    dead_lettered|config_error|delivery_unknown → DRIFT_ALERT_UNSENT
    其它 / 空 / 无法解析                        → DRIFT_ALERT_UNSENT(绝不拿「没有证据」当「已送达」)
```

四个决定,每一个都有具体理由:

* **kind = `external_config_error`,不是 `permission_blocked`。** 后者是个陷阱:它在
  `AlertChannelHub.LEAD_KINDS` 里,每个 reconcile tick 都会用
  `pane-blocked-classifier` 重判 Lead 的 pane,而那条规则只认
  `/permission.*(required|denied)/i` —— dev-channels 框两个词都没有。于是在
  queue-drain 路径上,Hub 会判定「Lead 已恢复」并**把工单自己关掉**,而 Lead 还停在
  框上。那正是本单要消灭的那一类静默恢复 bug,只是上移了一层。
  `external_config_error` 已在 shell allowlist 里、不在任何 LEAD_KINDS、本文件里就有
  先例(`_external_failstop_alert`),contact-book 把它路由给 **Tadashi** —— 这个
  launcher 的 owner,也正是「守卫认不出这个框」的正确 responder。
  operator 看到的是我们自己传的 `--title`/`--body`,不是 kind 的罐头文案。
  **生命周期,说准确**:直投路径(shell 直接 POST Discord)不写 `alert_threads`,
  没有后续 lifecycle;但 Discord 瞬时失败时会落 `~/.flywheel/alert-queue/`,Bridge
  drain 之后**会**为非 informational kind 建持久 thread。关键在于它**不在**
  `LEAD_KINDS` 里,所以不会被 pane 分类器判成「已恢复」自动关单 —— 那才是弃用
  `permission_blocked` 的理由。contact-book 的 Tadashi 是 responder 约定,不是
  `lead-alert.sh` 里按 kind 分支的路由。真要做成 durable ticket,应另开一个 kind
  (并进 TS union —— FLY-1082 的 drift guard 只 grandfather 了现有两个 shell-only kind)。
* **severity = `warning`,不是 `severe`。** `lead-alert.sh` 在 claims 去重**之前**就把
  caller 的 severity 写进 `alert_version_observations`,而 release-readiness 的
  `severeHold = 1` —— **一条**关于守卫的诊断信号就能把 12 小时 release soak 冻成
  hold。`warning` 的门槛是 5(`warningHold`),所以单条不会;但**五条不同的
  Lead/形状事件仍然会**,这不是「不可能 hold」,只是不会被一条诊断信号绊倒。
  `warning` 也正是这一族的 `severityFor()` 规范值。
* **去重签名 = 失败形状 + UTC 日桶。** 不能用屏幕摘要:活着的 pane 不可能两次字节
  相同,那等于每次冷启都铸一把新钥匙(现在刷屏)。也不能用纯形状:`alert_claims`
  **没有 pruner**,`sent` 回执之后永远直接返回 0,纯形状等于**永久、不可清除的静音**
  —— 同一个 Lead 下个月同样卡住会悄无声息,正是本告警要防的事,只是推迟了。加日桶
  之后:同一形状每 Lead 每天最多一次(KeepAlive 重启循环也压得住),换一天再犯还会响。
  这与 `lead-alert.sh` 自己的默认签名是同一个形状。
* **body 只带 flag、几何和摘要,绝不回显 pane 文本**(FLY-1948 / FLY-220 echo
  immunity)。几何是形状不是内容,而且是 responder 第一个想看的东西。

* **送达判定不能看退出码。** `lead-alert.sh` 的 **exit 2 同时表示两件相反的事**:
  「已持久入队,Bridge drain 会送」和「已死信,永远没人看到」(缺频道、缺 token、
  永久 4xx 都走死信)。而缺 token 恰恰是最常见的降级,也正是日志最该准确的那条路。
  所以传 `--strict-delivery`,解析它那一行机器可读回执:`sent` / `duplicate` /
  `queued_transient` 记 `DRIFT_ALERT_SENT`;`dead_lettered` / `config_error` /
  `delivery_unknown` 记 `DRIFT_ALERT_UNSENT`;**拿不到回执也记 UNSENT** —— 绝不
  把「没有证据」当成「已送达」。

其他:找不到 `lead-alert.sh` 要**记一行**而不是静默返回 0
(静默返回 0 就是本单本身);调用包在命令替换里(本函数所处的后台 job 位置,实测
发生过裸外部命令被 exec 替换、连带带走 poller),并在有 `timeout`/`gtimeout` 时限时
60s(`lead-alert.sh` 会跑 curl + sqlite3 + jq,挂住就会留下常驻进程,而这个 poller
要等 Claude 退出才被 reap —— 几小时甚至几天)。

## 4. 测试

### T1 `fly1679-dev-channels-v2.test.sh`

P1–P7 一行不动(护栏)。新增,fixture 用**当前安装的 claude 2.1.280 真实 capture**:

| 用例 | 内容 | 期望 |
|---|---|---|
| P8 | 49x16 真实可见 capture(标题滚出、提示句折行) | present |
| P9 | 120x40 真实 capture(旧形态) | present |
| P10 | P8 去掉选项行,只留正文 | absent |
| P11 | 只有选项行、正文一句不剩 | absent |
| P12 | 选项行**出现在行中**(转述形) | absent |
| P13 | 折行的提示句、没有选项行 | absent |
| P14 | **带边框 + 窄 + 折行**(边框夹在句子两半之间) | present |
| P15 | 整块渲染的转述 + **活 composer 在下面** | absent |
| P16 | 复制了选项行但**没有模态底栏** | absent |
| P17 | 普通编号列表复用了这个标签 + 一句正文 | absent |
| P18 | **43x16 真框**(选项行自己折了) | absent(fail closed) |

P10/P11/P13 = QA 判据 2 的「只中一段必须不匹配」。P14 = round-1 BLOCKER 3 指出的
未覆盖组合。P15/P16/P17 = round-2 代码评审 BLOCKER 1 实际构造出来的误判屏幕。
P18 钉住「太窄就不按」这条安全边界(它的**告警**由 A1g 负责)。

改动的既有用例(诚实登记,不是「一行不动」):

* **T4b** 把 classification 行按字节钉死,C2 加了 `geom=` / `match_dangerously=` /
  `match_option_row=`,必须重新对齐。这个字面量是**漂移报警器**,不是格式偏好 ——
  它守的是「超时路径只记形状、绝不记 pane 文本」。修的时候重新对齐字面量,**不要**
  放松成子串匹配。
* **T4c(新)** 同一块屏幕必须**不**发漂移告警(评审 BLOCKER 7 的负例)。

### T2 `fly2776-dev-channels-geometry.test.sh`(新)

* **F 层 —— 真 tmux + 假 Claude(在 CI 里把关)**。CI 不装 claude 二进制,所以 G 层在
  CI 里是**永久 SKIP**;变异负控若只活在 G 层,就等于什么都没守住
  (`quiet-gates-require-qualified-evidence`)。tmux 在 shard 上是装的,所以 F 层用
  fly1679 E 层同款的「真 tmux + 假 Claude 画逐字 fixture」形状,秒级、处处可跑,
  并且真的走完 capture → 认框 → send-keys → verify。
  * F1 49x16 必须认出、确认,且**恰好一个 `1`、零个 Enter**
  * F2 删掉归一化 → 必须转红且**一个键都不发**
  * F3 把行锚定删掉的变异**拿去跑行内转述**:变异版必须**错误命中**、发行版必须
    拒绝。只证明「变异施加成功」等于没证明任何东西会抓住它(round-2 NIT 7)。
* **H 层 —— 守 F 层那个唯一的 skip 出口**。F1 只允许一种 skip:宿主明确拒绝
  raw tty。那是本文件里最危险的一行 —— 一旦放宽成「stty 失败就跳过」,任意 harness
  故障都会报出一个干净、全绿、其实一行没执行的 F 层,正是本单要消灭的形状。
  * H1 明确的能力拒绝 → SKIP 并说明
  * H2 任意 stty 失败 → **红**,不许跳
  * H3 **CI 里**的能力拒绝 → **红**(CI 是 F 唯一把关的地方,在那儿跳过就是把
    唯一的闸门悄悄拆了)
* **G 层 —— 真 tmux + 当前安装的真 claude(QA 判据 1)**。49x16 与 120x40 两种几何
  都必须 matched + confirmed,**并且 pane 进程仍存活、Claude 的 composer 在屏**。
  只断言「框消失了」是不够的 —— Claude 退出、或停在别的 modal 上,同样满足它
  (round-2 BLOCKER 3)。无二进制、或 F1 没能在本机证明按键可送达时,SKIP 并打印
  原因,绝不静默当 PASS。输出作为一次性验收证据写进 PR body。
* **M 层 —— 同一变异对真二进制重跑**(QA 判据 3)。只有 49x16 能承载这个变异:
  120x40 下标题可见且不折行,变异照样匹配 —— 这正是当年在正常终端上测不出这个 bug
  的原因。
* **A 层 —— 告警**:A1 部分命中恰好告警一次 · A1b classification 带新证据与几何 ·
  A1c kind/severity 正确(且**不是** `permission_blocked` / `severe`)· A1d 签名是
  形状 + 日桶 · A1e body 不回显 pane 文本 · A1f 传了 `--strict-delivery` ·
  **A1g 43x16 真框不按但也不静默** · **A1h 30x16(选项行和底栏都折了)同样不静默** ·
  A2 没弹框不告警 · A2b 聊这个 flag 的 Lead 不告警 · **A2c 渲染整块 capture 且
  composer 在屏的 Lead 不被 page** · A3 告警失败不拖垮 poller 且日志点名 ·
  **A4 rc=2 + `queued_transient` 记已送达** · **A4b rc=2 + `dead_lettered` 记 UNSENT**
  (同一个退出码,相反的结果)· **A4c 拿不到回执一律记 UNSENT** · A5 找不到
  `lead-alert.sh` 也要点名。

### T3 CI 登记(精确位置)

* `.github/workflows/ci.yml` —— 加到 job `script-tests-6` 里**既有的** step
  *Test — FLY-1663 launchd-native Lead lifecycle*,紧跟 `fly1679` 那一行。挂在既有
  step 上可以避开改 `ci-structure.test.sh` 的 `expected_shard_tests`;新开命名 step
  则必须同步改那里。
* 分类守卫是 `scripts/__tests__/ci-shell-suite-enumeration.test.sh`(quick-gate 里跑),
  另一个登记面是 `ci-shell-suite-manual-only.txt`,两者互斥。
* **预算**:shard 6 已经被 fly1679 的 E/H 家族占满(FLY-1870 有记录)。本套件在 CI 里
  只跑 F + H + A(G/M 因无 claude 二进制 SKIP)。F 两个 pane + H 三个 pane,
  `FLY2776_TIMEOUT=6`/`2`,合计秒级。
* `packages/claude-runner/test/fixtures/kill-path-inventory.json`:本套件目前只有
  `tmux … kill-server`,不匹配扫描器的任何模式,**不需要**登记;一旦加入
  `kill -0` / `kill -TERM` 就必须同步。

### 本地验证(targeted,非全仓)

```bash
pnpm lint
bash scripts/__tests__/fly1679-dev-channels-v2.test.sh
bash scripts/__tests__/fly2776-dev-channels-geometry.test.sh
bash scripts/__tests__/fly1680-v1-extinction.test.sh        # 同一 launcher 的另一消费者
bash scripts/__tests__/discord-plugin-cutover.test.sh       # 引用 poller 调用点
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh   # 新套件分类守卫
```

`claude-lead.sh` 是 shell,无 TS 导出变化,不需要 `pnpm --filter` 构建/typecheck。
消费者扫描结果逐个列进 PR body。

## 5. 顺序

1. T1 加 P8–P14 → 红(P8 复现事故)
2. C1 → P1–P14 全绿
3. T2 的 F/A 层 → 红
4. C2 → 绿
5. G/M 层对真二进制跑一遍,输出进 PR body
6. ci.yml 登记 + 分类守卫
7. 评审 round-2/3 的补强:P15–P18(误判 / 太窄 fail-closed)、H 层(守住 F 唯一的
   skip 出口,含 CI 分支)、A1f–A4c(送达回执与日桶)、F3(行锚定变异真被抓住)、
   G 的 pane + composer 双证据
8. D1 里程碑,literal last commit

## 6. 明确不做

* 不放大 pane、不动 carrier / launchd / 生产 Lead(QA 判据 5)
* 不新增 lead-alert kind(理由与代价见 §3.3)
* 不改按键(单发 `1`、不发 Enter,实测仍正确)
* 不扫 scrollback(research §3 B:会把搜索面扩到重放的 transcript)
* pane 49x16 本身偏小 → 另开单,不在本 PR

## 7. 设计评审记录 / Lead 裁定

* **两条 vendor lane 同时不可用**(2026-09-22):
  * Codex companion(effort xhigh)返回 `You've hit your usage limit … try again at Sep 27th, 2026 2:25 PM`。
    按 `codex-quota-review-fallback` 的 Lead 裁定,**不**执行 `codex-profile use/next`
    (凭据是全舰共享的,本地切档会让整个舰队漂移)。
  * `gemini` CLI 仍是 `IneligibleTierError: This client is no longer supported for
    Gemini Code Assist for individuals`(与 FLY-2770 同因)。
* **Lead 指令 `ccd2a2ac-1b12-47ac-af5c-8d07e7c7e11a`**(2026-09-22):同意根因更正与修法;
  若 17:10 PT 前未收到 Codex profile 切换通知、或 Codex 仍报 limit,直接用
  fresh-context subagent 评审并写 leadAcceptance,不再请示。17:10 PT 未收到通知。
* **独立评审(round 1)**:fresh-context reviewer 自行读源、自行执行候选 shell,
  结论 **CHANGES REQUESTED**,8 个 BLOCKER + 10 个 NIT。全文见
  `design-feedback-round1.md`(与本计划同目录)。
* **leadAcceptance**
  * `instructionId`: `ccd2a2ac-1b12-47ac-af5c-8d07e7c7e11a`
  * `codexFinalVerdict`: `not_run_pool_exhausted`
  * `substituteReview`: independent fresh-context reviewer, round 1, CHANGES REQUESTED
    → 全部 8 个 BLOCKER 已处置(见下表),feedback 与本计划同目录存档并在 PR body 引用。

### BLOCKER 处置

| # | 结论 | 处置 |
|---|---|---|
| 1 | 接受 | `[│┃\|]` 字节集合陷阱。实现里从未用方括号(改前就是 `LC_ALL=C` + ERE 交替);**计划文本**已按实现改正。评审实测 locale-unset 下方括号写法会红掉 P1/P8/P9 |
| 2 | 接受 | `grep -qF` 匹配 `--` 开头模式必须 `-e`。实现已是 `-qF -e`;计划文本改正 |
| 3 | 接受 | 归一化前先折边框(`sed 's/│/ /g'`),新增 **P14**(带边框+窄+折行)覆盖 |
| 4 | 接受 | pipefail/SIGPIPE。实现全程 here-string + 命令替换,零管道;计划文本改正(普通子 shell 挡不住 141) |
| 5 | 接受 | `--severity severe` → `warning`。severe 在去重前写入 `alert_version_observations`,`severeHold=1` 会把 release soak 冻成 hold |
| 6 | 接受 | 弃用 `permission_blocked`(在 `LEAD_KINDS` 里 → queue-drain 路径上工单会自判「已恢复」自己关掉)。改用 `external_config_error`:零新增登记、不在任何 LEAD_KINDS、contact-book 路由给 Tadashi。评审推荐的 (c) 新建 kind 记为后续项 —— 代价与取舍写在 §3.3 |
| 7 | 接受 | 漂移判定从「四 flag 命中任一」改为「结构 flag 命中 **或** 两句独立正文」;签名从屏幕摘要改为失败形状。新增 **T4c / A2b** 两个负例 |
| 8 | 接受 | 新增 **F 层**(真 tmux + 假 Claude,CI 里把关)并把变异负控放在那里;G/M 层保留真二进制,作为 PR body 里的一次性验收证据。CI 登记位置按评审给的精确坐标 |

### NIT 处置

1 采纳(优先用 `LEAD_ALERT_SH`,找不到脚本要点名)· 2 采纳(rc=2 记为已送达)·
3 采纳(命令替换 + `timeout` 限时)· 4 采纳(新增 A5/A3 覆盖降级路径)·
5 采纳(光标 `❯` 改为可选)· 6 **登记不修**(整块粘贴的残余风险,见 §2.3;
代价有界,不为此把守卫绑死在更多可能漂移的文字上)· 7/8 实现里已做 ·
9 采纳(几何进 alert body)· 10 采纳(44 列写进代码注释)

## 8. 设计评审 round 2 + 代码评审 round 1(Codex,2026-09-23)

Codex 在 16:51 PT 恢复(Lead 指令 `ef321848-e9dc-44ff-b6fa-62b5d4137147`),两条线都
跑了 `effort=high`,结论都是 **CHANGES REQUESTED**,且**互相独立地指向同一批问题**。
全文存档同目录:`design-feedback-round2.md`、`code-review-round1.md`。

> round-1 的 subagent 评审与 leadAcceptance(§7)**不回退**:它当时满足 Lead 给的
> 条件分支,并且抓到了 locale 字节集合和 `permission_blocked` 自动关单这两条真问题。

### BLOCKER 处置(代码评审编号)

| # | 结论 | 处置 |
|---|---|---|
| 1 | 接受 | **误判**:独占一行的转述会被当活框。加两个模态条件 —— 模态底栏必须在屏 + Claude composer 指示符 `⏵⏵` 必须**不**在屏(框是模态的,会挡住 composer)。新增 P15/P16/P17 |
| 2 | 接受 | **43x16 既不按也不告警**,与「不再静默」直接矛盾。加第三条告警通路「折行后的选项标签 + 模态底栏」。设计评审 round-2 独立复现到更窄的 **30x16**,同样覆盖。新增 A1g/A1h,并用真二进制抓了 43x16 与 30x16 两份 fixture |
| 3 | 接受 | **exit 2 同时是「已入队」和「永久死信」**,原实现把死信记成 SENT。改用 `--strict-delivery` 解析回执;拿不到回执一律 UNSENT。新增 A1f/A4/A4b/A4c |
| 4 | 接受 | **纯形状签名 = 永久静音**(`alert_claims` 无 pruner)。签名加 UTC 日桶。A1d 相应改写 |
| 5 | 接受 | raw-tty 三态守卫(评审时尚未提交)。另加 **CI 里 `denied` 必须红** —— CI 是 F 唯一把关的地方。新增 H1/H2/H3 |

### NIT 处置

6 采纳(G1/G2 改为断言 pane 存活 + composer 在屏,不再把「框消失」说成「可收信」)·
7 采纳(F3 真拿变异判定式去跑行内转述,要求变异错误命中、发行版拒绝)·
设计评审 NIT 1 采纳(§3.3 把直投 / queue-drain 两条生命周期写准确)·
NIT 2 采纳(A1c 措辞改为「门槛是 5 而非 severe 的 1」,不再说「不可能 hold」)·
NIT 3 采纳(§4 预算改为「F 两个 pane + H 三个 pane」;里程碑按 literal-last 合同在
最后一个 commit 建,不是遗漏)。

### 决策矩阵(真二进制 fixture,locale unset / C 两档一致)

| 屏幕 | 按键 | 告警 |
|---|---|---|
| 真框 120x40 / 49x16 | ✅ 认出并确认 | **不告警** |
| 真框 43x16 / 30x16(选项行折了) | ❌ fail-safe | **告警** |
| 行内转述 / 整块转述(composer 在屏) | ❌ | 不告警 |
| 纯 live prompt | ❌ | 不告警 |

第一行是 round-3 BLOCKER 3 纠正过来的:**认出并确认成功的框根本走不到 NOT_SEEN**
—— poller 在 `confirmed=1` 处就 return 了,classification 和漂移判定都不可达。
自动确认成功不是漂移,不该 page 任何人。(我之前那张矩阵是拿一个独立的判据 harness
算出来的,它脱离了 poller 的控制流,所以把「如果走到 NOT_SEEN 会不会告警」误写成了
「会告警」。)

## 9. 设计评审 round 3(Codex,2026-09-23)

全文:`design-feedback-round3.md`。结论 **CHANGES REQUESTED**,3 BLOCKER + 1 NIT,全部处置。

评审目标是 `9cfd9807`,而分支在评审期间前进到了 `9f3a7177` —— 评审自己也写明了这一点。

| # | 结论 | 处置 |
|---|---|---|
| 1 | 接受(**评审开始前已修**) | H1 继承 runner 的 `CI=true`,走进我自己刚加的「CI 里 denied 必须红」分支,于是必然 FAIL。评审目标 `9cfd9807` 上确实是红的;`ef007d74`(已在 HEAD)把 CI 值改成逐用例显式传入,H1/H2 跑本机分支、H3 跑 CI 分支。评审也确认这就是正确的最小修法 |
| 2 | 接受 | **plan 的可执行片段还停在改之前的版本**:§2.2 少了 `footer_re` 与 `⏵⏵` 否决、§3.1 少了三个新 flag、§3.2 还是两通路 + 5 位 shape、§3.3 少了 `--strict-delivery` 与日桶。散文改了、代码块没改 —— 而归档的是代码块。照着它抄就等于把 round-2 的 BLOCKER 原样放回去。已逐段同步到与 `claude-lead.sh` 一致 |
| 3 | 接受 | **决策矩阵第一行写错了**:「真框 120x40 / 49x16 → 告警」。实际上**认出并确认成功的框根本走不到 NOT_SEEN** —— poller 在 `confirmed=1` 处就 return,classification 与漂移判定都不可达。自动确认成功不是漂移,不该 page 任何人。已改成「不告警」。我那张矩阵是用一个脱离 poller 控制流的独立 harness 算的,这是它的锅 |
| NIT 1 | 接受 | §0「两段特征」→ 三类;§1 的 T1 改 P8–P18、T2 改 F/G/M/A/H 五层、C2 补齐新 flag;§5 顺序补第 7 步 |

**round-3 没有推翻任何已落实的行为** —— 它明确确认三个 round-2 BLOCKER 都已关闭,
问题全部出在归档文档与实现的漂移,以及一个在它开始审之前就修好的测试 bug。

## 10. 代码评审 round 2(Codex,2026-09-23)

全文:`code-review-round2.md`。结论 **CHANGES REQUESTED**,1 BLOCKER + 1 NIT,均已处置。

| # | 结论 | 处置 |
|---|---|---|
| 1 | 接受 | **P15 是假测试。** 它本该验证「整块渲染的转述 + 活 composer」被 `⏵⏵` 否决挡住,但 fixture 每行带 `> ` 前缀,**行锚定在到达 composer 检查之前就先失败了** —— 删掉 composer 检查 P15 仍 absent。后果:谁重构掉那三行,所有 P 用例照样全绿,而显示无前缀 capture 且 composer 存活的 Lead 会被真按一个 `1`。修法:P15 改成无前缀独立行(保留 composer);新增 **P15b**(去掉 composer 行必须 present → 拒的是 veto 不是 anchor)与 **P15c**(删 veto 后 mutant 必须 present、shipped 必须 absent,与 F3 同形) |
| 2 (NIT) | 接受 | 生产总览注释还写「TWO mutually independent features」+「FOCUSED OPTION ROW」,而实现已是三类证据、caret 可选。风险是后人照总览把 modal 条件简化掉。已改成三类证据 + line-anchored,并写明挡转述的是锚定不是 caret |

评审同时复核确认 round-1 的全部行为修复仍在,根因事实与源码 fixture 一致。

**至此三类证据各有一道变异负控:** 归一化(F2 / M1)、行锚定(F3)、composer 否决(P15c)。
这三条是这份守卫真正的护栏 —— 任何一条被「简化」掉,对应用例必须转红。

## 11. 复评收口(2026-09-23)

* **设计 round 4**(`design-feedback-round4.md`)—— **APPROVED**,目标 `0265c9d9c`。
  逐段核了 §2.2 / §3.1 / §3.2 / §3.3 / §0-§1-§5 与源码的一致性(differing lines: none),
  并顺着 poller 控制流逐行确认了 §8 决策矩阵。
* **代码 round 3**(`code-review-round3.md`)—— **APPROVED**,目标 `9d4fb582c`。
  它自己独立抽出判定式做了变异测量:
  `shipped_p15=absent / mutant_p15=present / shipped_no_composer=present / mutant_no_composer=present`
  并确认 P15c 的 `sed` 不是空操作(source veto hits 1、mutant 0、predicate changed yes)
  —— composer 否决确实是**承重**的。

两轮都是 Lead 授权的 scoped 复评(设计见 §9 前的裁定,代码见 instruction
`b41588d1-dc1d-48c9-87e5-d918020993ea`),只核前一轮的处置,不重开已定事项。
