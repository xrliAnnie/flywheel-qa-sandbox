# FLY-2145 Lead 记忆私有仓 — 验收
Issue: FLY-2145 (https://linear.app/geoforge3d/issue/FLY-2145/2132a1-lead-记忆建私有仓一仓十二夹-全读只写自家-首搬-真密钥扫描)
日期: 2026-09-03
基于: plan.md

## 当前结论

本文件按执行进度记录证据，不提前宣称验收完成。Founder 已于 2026-09-03 解除额外等待，授权 gate `49808890-a45a-49ff-a813-830297ea1240` 返回 `APPROVED`。Lead 已在其家目录权限下完成 `--prepare`、36/36 当次 blob 亲审和修复后的 `--publish`。首搬提交 `0d5c497bcbfeee1bd111ca6ad2f5f42d06287609` 已到达私有远端 `main`，后续护栏管理修复提交 `f39602a8b59115fd7e5514f85e89e2cc9cc0bad7` 也已同步，二者 Actions 均绿；一次性 fresh clone 的快照、跨夹读、三层跨夹写拒绝、live/source/clone 三方哈希、自家夹冒烟及清理均已通过。实施 runner 未读写真实目录；所有活仓命令均由 Lead 按逐字清单执行。

## 远端创建证据

2026-09-03 创建 `https://github.com/xrliAnnie/lead-memory`。

```text
gh repo view xrliAnnie/lead-memory --json isPrivate,defaultBranchRef,url,createdAt
createdAt: 2026-09-03T17:00:03Z
url: https://github.com/xrliAnnie/lead-memory
isPrivate: true
defaultBranch: <empty before first push>; main after first push

git ls-remote --heads https://github.com/xrliAnnie/lead-memory.git refs/heads/main
<empty before first push>; 0d5c497bcbfeee1bd111ca6ad2f5f42d06287609 after first push

curl (anonymous) https://github.com/xrliAnnie/lead-memory
HTTP 404
```

空仓不需要预先补 default branch。`scripts/lead-memory/first-import.sh --publish` 的首次受审计 push 已创建 `main`，随后显式设置并复核 default branch=`main`、private=`true`。

## Founder HTML 交付

设计 HTML 已通过 runner-safe `publish-only` 路径发布到 7 天有效的托管 URL：

`https://fw-reports-a53de2.vercel.app/r/691bbc35114dda38548484fe8ab9a502/`

托管页验收：HTTP 200；`__CSP_NONCE__` 占位符残留 0；交互 `<script>` 带运行时真实 nonce。runner 无 Discord 投递权限，因此没有绕权直发；已通过唯一 report 通道把 URL 和 `reportId=691bbc35114dda38548484fe8ab9a502` 交给 Lead（report `23503cc2-3c8e-42e2-882a-90afc7dae4fe`），由 Lead 在 founder issue thread 中转交。

## 真实目录前置证据

只读检查结果（写失败前后相同）：

```text
Lead folders: 12
Files: 1138
Disk usage: 29M
Symlinks: 0
Target-owned .git before attempt: absent
```

首次 `bootstrap.sh --init` 的所有业务预检均通过，但沙箱拒绝创建 `~/.claude/agent-memory/.git`，返回 `Operation not permitted`。复核确认没有残留 `.git`，文件数和磁盘占用不变，远端仍为空。之后 Lead 在授权解除后亲自执行 `first-import.sh --prepare` 成功；实施 runner 没有重试或越权写该目录。

## 只读镜像真扫描与人工抽样

在不写真实目录的前提下，`scripts/lead-memory/preflight-mirror.sh` 把 12 夹复制到 mode-private 临时目录，初始化临时 Git 索引，运行与首搬完全相同的不可变树和双扫描，退出时删除敏感副本。真实源目录没有新增 `.git` 或 `SCAN-LEDGER.md`。

```text
gitleaks: 8.30.1
TruffleHog: 3.97.2 (--no-verification --fail-on-scan-errors)
Positive controls: 8/8 gitleaks mappings; 4/4 TruffleHog mappings
Scanned-Tree: b7c8cafd4927e536dadba3808e1f0d9da884184a
Scanned-Bytes: 27802103
gitleaks raw findings: 0
TruffleHog findings: 0
```

按台账对 12 夹各 3 个、共 36 个抽样文件逐份只读复核，未发现疑似凭据。每条复核已写入权限 `0600` 的私有、value-free receipt；签字后再次计算当前源文件 Git blob OID，`36/36` 与预扫一致。真实 `--publish` 仍会全量重扫；receipt 的 36 个 `path + blob OID` 必须全部匹配才会回填，任一变化都 fail-closed。

2026-09-03 continuation 轮询时再次只读复算：receipt 仍为 `0600`，36/36 blob 匹配、0 变化、0 缺失；外层 `~/.claude/.gitignore` 类型安全，Git 全局配置中没有 `remote.origin.pushurl`。因此 Lead 获批后仍可直接执行当前 head 的两阶段首搬，不需要先重做人审。

## Lead 两阶段清单与执行状态

这两条命令内部自带版本、私有性、精确路径、12 夹、无符号链接、不可变树、台账、staged scope、远端竞态和回滚前状态检查。`--prepare`、当次 36 份人审和修复后的 `--publish` 均已于 2026-09-03 完成：

```sh
cd /Users/xiaorongli/Dev/flywheel-FLY-2145
scripts/lead-memory/first-import.sh --prepare

# 人工逐条复核 SCAN-LEDGER.md：扫描命中逐条处置；
# 12 夹各 3 个、共 36 个 blob-bound sample 填：
# reviewed: <short conclusion> | <reviewer> | YYYY-MM-DD

scripts/lead-memory/first-import.sh --publish
```

`--prepare` 永不 commit/push。`--publish` 会重新跑完整双扫描；命中或人工复核不全就 fail-closed。若本地 commit 成功但 push 失败，重跑 `--publish` 只会复核并续推该根提交，不会造第二个首搬提交。

预扫阶段已对只读镜像台账的 36 个抽样文件逐份检查；真实 prepare 后，Lead 又按当前树的 36 组 `path + blob OID` 亲自重审并改签私有、value-free receipt。`--publish` 仅在这 36 组值全部等于当次终扫时自动回填；任一文件变化都会拒绝旧签字，要求重审。

推送前回滚：保留全部 12 夹和记忆文件，只删除 target-owned `~/.claude/agent-memory/.git`；仅当私有 `prepare.txt` 记录 `OUTER_IGNORE_PREEXISTING=false` 时，才从 `~/.claude/.gitignore` 删除精确的 `agent-memory/` 行。远端此时仍为空，可由 GitHub owner 另行删除。脚本不自动执行回滚。

## 真实首搬 prepare 回执

Lead 返回 `PREPARE_EXIT=0`，并提供如下 value-free 原样字段：

```text
PREPARED_AT=2026-09-03T23:02:59Z
OUTER_IGNORE_PREEXISTING=false
LEAD_METRICS_BEFORE=files=1145 bytes=27847841 sha256=fd90bdbeb4e95da8f812f790deec792c76eac08be33896bdba99530118d1da08
LEAD_METRICS_AFTER=files=1145 bytes=27847841 sha256=fd90bdbeb4e95da8f812f790deec792c76eac08be33896bdba99530118d1da08
Scanned-Tree: 25652fc141985185d73c460ee962a194d04ca9eb
Scanned-Bytes: 27847841
Positive-Controls: 8/8 gitleaks mappings; 4/4 trufflehog mappings
gitleaks real-tree findings: 0
trufflehog real-tree findings: 0
REMOTE_MAIN=absent
PREPARE_EXIT=0
```

阳性对照实际触发：gitleaks 9 条、TruffleHog 4 条；真实树为 0/0。12 条 Lead 名称→子树映射齐全。扫描前后 `files`、`bytes`、`sha256` 三项逐字相同，证明 prepare 扫描窗口内内容没有漂移。私有回滚锚点记录 `OUTER_IGNORE_PREEXISTING=false`。

## 真实人审与首次 publish fail-closed 回执

Lead 亲自复核了 prepare 当次树的全部 36 个 sample，私有 receipt 的 value-free 结构复核结果为：

```text
REVIEW_ROWS=36
REVIEW_COLUMNS=5
REVIEWER=flywheel-eng-lead
REVIEW_DATE=2026-09-03
REVIEW_DISPOSITION=reviewed: no credential material observed; dual scan 0/0
RECEIPT_MODE=600
ALL_36_PERSONALLY_REVIEWED=yes
RECEIPT_TREE=25652fc141985185d73c460ee962a194d04ca9eb
UNIQUE_PATH_OID_ROWS=36
```

第一次 `--publish` 在真实树终扫、commit 和 push 之前退出：gitleaks 阳性对照只映射 7/8（缺 `generic-api.txt -> generic-api-key`），TruffleHog 映射 4/4，`PUBLISH_EXIT=1`。远端 `main` 仍不存在，本地没有 commit；prepare 留下的 staged tree 保持未发布。这次失败证明阳性对照映射不全时流程会 fail-closed。

根因是旧夹具每次通过 `secrets.choice` 重新生成通用 token，某些随机样本没有达到 gitleaks 规则当次的熵阈值。TDD 红灯先以两次独立扫描的 value-free SHA-256 指纹证明夹具不稳定，再在 `e9b68aede` 改为按规则标签确定性派生的高熵样本。修复后单元套件 21/21；安装的 gitleaks 8.30.1 + TruffleHog 3.97.2 真实套件独立连跑 3 次，每次均为 8/8 + 4/4 映射、真实测试树 0/0。修复不变更真实树扫描、receipt 校验或 commit/push 边界。

## 真实首搬 publish 回执

修复后 Lead 按要求只运行一次 `--publish`，没有在前后编辑、reset 或重试。原样状态边界与 value-free 回执为：

```text
PUBLISH_EXIT=0
PUBLISHED_AT=2026-09-03T23:24:01Z
REPOSITORY=xrliAnnie/lead-memory
PRIVATE=true
DEFAULT_BRANCH=main
IMPORT_SHA=0d5c497bcbfeee1bd111ca6ad2f5f42d06287609
REMOTE_MAIN=0d5c497bcbfeee1bd111ca6ad2f5f42d06287609
LIVE_BRANCH=main
LIVE_STATUS_BEGIN
LIVE_STATUS_END
Scanned-Tree: 25652fc141985185d73c460ee962a194d04ca9eb
Scanned-Bytes: 27847841
Positive-Controls: 8/8 gitleaks mappings; 4/4 trufflehog mappings
gitleaks raw findings: 0
trufflehog findings: 0
status: PASS
LEAD_METRICS_BEFORE=files=1145 bytes=27847841 sha256=fd90bdbeb4e95da8f812f790deec792c76eac08be33896bdba99530118d1da08
LEAD_METRICS_AFTER=files=1145 bytes=27847841 sha256=fd90bdbeb4e95da8f812f790deec792c76eac08be33896bdba99530118d1da08
```

fresh clone 从仓内台账独立读得 `gitleaks raw findings=0`、`trufflehog findings=0`和 36 条完整的 Lead 人审行，因此上述 gitleaks 字段不仅依赖 Lead 的 sed 摘要。GitHub Actions `Lead memory guard` 对 `IMPORT_SHA` 通过：[run 33817433682](https://github.com/xrliAnnie/lead-memory/actions/runs/33817433682)。

## C6 fresh-clone 验收证据

授权 fresh clone checkout 精确的 `IMPORT_SHA`，得到：

```text
CLONE_HEAD=0d5c497bcbfeee1bd111ca6ad2f5f42d06287609
TRACKED_FILES=1156
TREE_LIST_SHA256=cea566019e29428525719d048ef722c941ef1db6f8fce9468037c3bab72fc2d8
LEAD_FOLDERS=12 exact expected names
REBUILT_LEAD_TREE=25652fc141985185d73c460ee962a194d04ca9eb
REBUILT_MAPPINGS=12
LEDGER_SCANNED_TREE=25652fc141985185d73c460ee962a194d04ca9eb
LEDGER_GITLEAKS=0
LEDGER_TRUFFLEHOG=0
LEDGER_REVIEWED_ROWS=36
IMPORT_OWNER=admin
CROSS_FOLDER_READ=PASS (sub-lead/MEMORY.md read to /dev/null)
CLONE_STATUS=<empty>
```

同一次性 clone 和隔离的 `FLYWHEEL_STATE_DIR` 中，以 `flywheel-eng-lead` 修改 `sub-lead/MEMORY.md`：普通 commit 以 rc=1 拒绝并且审计日志精确 +1；`git commit --no-verify` 仍被不可跳过的 `prepare-commit-msg` 以 rc=1 拒绝。再用 plumbing 造出违规提交 `1c4a73ce202d16ea419ee9a2d9bbe4b4558293c8`，pre-push 与 CI 共用的 `check-range` 都以 rc=1 拒绝 `owner flywheel-eng-lead does not match path sub-lead/MEMORY.md`；远端 `main` 在推送前后均为 `0d5c497bcbfeee1bd111ca6ad2f5f42d06287609`。

Flywheel 源码与本次 fresh clone 的四个护栏哈希逐项相等：

```text
.githooks/pre-commit           34d22c31c3c20bcae2576663aea38da70a35434eb77cb86ce344b324a110fc33
.githooks/prepare-commit-msg   66e3ba6a3df042f872fb457f72e155185d541aecfaeb58ee356927224a063848
.githooks/pre-push             ff75fde98ac87dd916dc537929999a1619b6f2a22f1bb460f37ce1ca354635b8
.githooks/lib/guard.sh         548cfcb1a8910aabef7fed1ea109eef1f06ecd3036c5f2494b408e0c395280af
```

Lead 在活仓用只读命令返回 `TREE_LIST_SHA256=cea566019e29428525719d048ef722c941ef1db6f8fce9468037c3bab72fc2d8`、tracked files=1156、重建 Lead 树 `25652fc141985185d73c460ee962a194d04ca9eb`、12 条映射、跨夹读 `PASS`、`core.hooksPath=.githooks`；四个 hook 哈希与上表逐项相同。因此 live/source/fresh-clone 三方代码、`IMPORT_SHA` 树清单和扫描树已显式合龙。鉴权 API 复核 `private=true`、default branch=`main`；无凭据 `curl` 复核 HTTP `404`。

### 自家夹冒烟与清理

Lead 用 `FLYWHEEL_LEAD_ID=flywheel-eng-lead` 只在自家夹新建临时 `_fly2145-smoke.md`，commit/push 得 `SMOKE_SHA=7ca7c0c4f7058143d922b46c6f3364f56837f1c2`，与当时远端 `main` 相同，活仓 status 为空。GitHub Actions [run 33817908481](https://github.com/xrliAnnie/lead-memory/actions/runs/33817908481) 通过。

绿灯后再用同一 Lead 身份只删除该哨兵，得 `CLEANUP_SHA=71f631141ad2a66c5ea070deccc94141af6cc940`，与远端 `main` 相同，`CLEANUP_SENTINEL_PRESENT=no`。GitHub Actions [run 33818154619](https://github.com/xrliAnnie/lead-memory/actions/runs/33818154619) 通过。清理后 `git status --porcelain` 的原样边界为：

```text
CLEANUP_STATUS_BEGIN
 M flywheel-product-lead/feedback-read-runner-live-state-not-your-inbox.md
CLEANUP_STATUS_END
```

该未暂存行是另一 Lead 在验收窗口内新写自家记忆，不属于 smoke/cleanup 两个提交；Lead 未 add/commit，runner 也未触碰。它依 C5 边界交由 A2 后续同步，同时证明首搬无停机窗口的新写可以原样保留。

## 实施节点自动化证据

当前实现 head 上与本单直接相关的 shell 套件全部通过：

```text
test-lead-memory-guard.test.sh: 56 pass
test-lead-memory-hooks.test.sh: 23 pass；带真 gitleaks 8.30.1 时 24 pass
test-lead-memory-bootstrap.test.sh: 56 pass（含 live-state 差异拒绝、显式确认、比较错误 fail-closed 与 mutation 阳照）
test-lead-memory-scan.test.sh: 21 pass
test-lead-memory-scan-real.test.sh: PASS；确定性正控修复后独立连跑 3 次均 PASS
test-lead-memory-workflow.test.sh: PASS
ci-structure.test.sh: PASS
CI shell suite enumeration: 262 suites explicitly classified
shellcheck + bash -n: PASS
```

模板同步另有显式负向证据：任何受管父目录或文件若是 symlink / 错误类型，会在首次写入前整体拒绝；测试以 `.githooks` 指向仓外目录，证明仓外哨兵与目标树都保持不变。真实目录的受管路径当前全部不存在，没有碰撞。

bootstrap 也在任何 `git init`、clone 或换位前检查外层 `~/.claude/.gitignore`：symlink 与非普通文件 fail-closed。红灯用例证明旧实现会跟随 symlink 并写坏仓外哨兵；修复后 bootstrap 在零目标改动时拒绝，仓外内容逐字节不变，完整套件 37/37 与 shell 静态检查通过。

canonical `remote.origin.url` 之外不允许在任意有效配置层级单独配置 `remote.origin.pushurl`，避免 fetch 指向私仓而 push 被静默重定向。bootstrap 对既有仓在首次改动前拒绝；`first-import --publish` 也重新检查，覆盖 prepare 后配置被注入的窗口。两个红/绿用例分别覆盖全局与本地注入并证明均在 push 前拒绝，完整 bootstrap/首搬套件更新为 39/39。

`first-import --publish` 在重扫或 commit 前还要求当前 symbolic branch 精确为 `main`。红灯先把 prepare 后的 unborn HEAD 指向 `alternate`，旧流程直到人工复核阶段仍继续；修复后立即拒绝且不造错误分支根提交，bootstrap/首搬套件 40/40。

同一套件也在一次性 fresh clone 中完整复演 C6 三层拒绝链：以 `flywheel-eng-lead` 修改 `sub-lead/` 时 commit 非零退出并只在隔离 audit 中追加一行；`--no-verify` 仍会被不可跳过的 `prepare-commit-msg` 拒绝；随后用 Git plumbing 直接构造同一违规对象，pre-push 拒绝且 bare remote `main` SHA 前后相同；CI 共用的 `check-range` 对同一 SHA 亦拒绝。Flywheel 源码、已安装仓和 fresh clone 的四个 hook / guard SHA-256 全部逐项相同。真实私仓首搬后的 C6 快照、拒绝链与三方哈希也已重跑并通过。

trailer 计数按 Git 的大小写不敏感语义复核：`Memory-Owner` 与 `memory-owner` 同时出现会被视为重复并 fail-closed，不能用大小写变体绕过“恰好一条”规则；规范 trailer 的取值仍只从精确 `Memory-Owner:` 行读取。

commit 校验先用 `git interpret-trailers --parse` 取真实末尾 trailer block，再做上述计数与归属检查；正文里形似 `Memory-Owner: admin`、后面仍有普通正文的行不会再被误认成 admin trailer。该红/绿用例同时证明解析临时材料只进入 `mktemp -d` 私有目录并在所有路径清理。

A2 的 sync 身份在 pre-push 层不能发布 `Memory-Owner: admin` 的历史，即便该提交由绕过 hooks 的 plumbing 预先造好；红/绿用例证明原实现会放行、修复后拒绝。合法的逐 Lead 单夹 sync 提交与显式 admin 首搬根提交仍分别通过真 hook 集成测试。

审计写入点会把所有外部字段中的 tab / CR / LF 规范为空格；恶意或损坏的身份值仍被拒绝，但不能把一条拒绝记录伪造成多行或额外 TSV 列。红/绿用例与全量 audit 检查证明每条记录恒为一行六字段。

新建远端 `main` 时不信任本地 `refs/remotes/origin/*` 作为已审计边界：pre-push 从根到待推 tip 检查完整历史。红灯用例先用本地伪造的 remote-tracking ref 隐藏一个无 owner trailer 的根提交并证明旧实现误放行；修复后同一提交因缺 trailer 被拒，guard 56/56、真 hooks 23/23 与 shell 静态检查通过。

全仓门禁的当前记录：`pnpm lint` 通过（只有既有 warning）；`pnpm -r build` 在补齐被 worktree 忽略的依赖后通过；`pnpm test:packages:run` 只在未修改的 `packages/core/test/tmux-viewer.macos.test.ts` 有 2/221 失败，原因是 resident runner 无法通过 AppleEvents 使用 Terminal.app（`osascript` 返回 syntax / Connection Invalid）。本单未修改或绕过这两个 GUI 测试；最终 head 会重跑全套，PR GitHub CI 是干净 host 上的硬门。

2026-09-03 11:04 PDT 在 `ff81566eb` 再跑中间全仓门禁：lint 与 22-package build 均为 exit 0；package suite 精确复现同一宿主限制（core 219/221，仍仅上述两个未修改的 Terminal.app 真机用例失败）。同一 head 的七组专项验收全部 exit 0：guard 55/55、hooks 23/23、bootstrap 34/34、scan 21/21、真实双扫描器、workflow、CI structure。TruffleHog 在受限 runner 中打印无法枚举其他进程 PID 的临时清理 warning，但 `--fail-on-scan-errors` 扫描和阳性/阴性断言均成功，因此不隐藏或降级扫描失败。

2026-09-03 16:38 PDT 在 `2a472a877` 运行实施节点要求的最终门禁：

```text
pnpm lint: exit 0（仅仓内既有 warning）
pnpm -r build: exit 0（22/23 workspace projects）
pnpm test:packages:run: exit 1
  packages/core: 219/221 passed
  only failures: test/tmux-viewer.macos.test.ts (2)
  host evidence: Terminal.app AppleEvents Connection Invalid / osascript syntax error
test-lead-memory-bootstrap.test.sh: 40/40
test-lead-memory-guard.test.sh: 56/56
test-lead-memory-hooks.test.sh: 22/22
test-lead-memory-scan-real.test.sh: PASS
test-lead-memory-scan.test.sh: 21/21
test-lead-memory-workflow.test.sh: PASS
ci-structure.test.sh: PASS
```

分支新增的六个 `scripts/__tests__/*.test.sh` 已全部显式执行；被修改的 `ci-structure.test.sh` 也额外执行。七组专项全部 exit 0。包套件的两个失败与前两次一致，且唯一涉及文件未被本分支修改；不改测试、不降级、不伪造全绿，由 PR GitHub CI 的正常宿主作最终硬门。

代码评审 R1 的 HIGH 修复后，2026-09-03 17:13 PDT 在 `e975b7d27` 又完整执行了上述三条精确全仓命令和七组 shell suite：`pnpm lint` 与 `pnpm -r build` 仍 exit 0；bootstrap 新增两条断言后 43/43，其余专项全绿。`pnpm test:packages:run` 仍有两个 Terminal.app 宿主失败，并在全仓并发负载下新出现一个 config census 5 秒 timeout；对应 `drift-scan.test.ts` 不改阈值、不改代码单独复跑 27/27，其中 census 实际用时 4.388 秒，确认是并发资源争用而非断言失败。

按 implementation node 合同通过 `codex:rescue` companion 发起了只读预审，没有调用 raw `codex exec`。companion 在读取仓库前被 resident 外层 macOS seatbelt 拒绝，返回 status 71（`sandbox_apply: Operation not permitted`），所以该次尝试没有 PASS/FAIL verdict，也没有 finding。最终 blocking 审查仍使用 request-driven cross-family `review_code` gate。

request-driven 实施代码评审 R1 在 reviewed head `d13c7dd02520ffbf10c9466bd23fff3553f1d73f` 返回 `CHANGES_REQUESTED`：唯一 HIGH `outer-gitignore-append-without-trailing-newline`指出外层 `.gitignore` 非空且无末尾 LF 时，旧实现会把 `agent-memory/` 粘到最后一条规则上，同时破坏旧忽略与新忽略。新夹具先以 `secrets.env` 无末尾换行复现 RED：bootstrap exit 0 但字节比对失败；`e975b7d27` 在一次 append 中先按最后一字节决定是否补 LF，再写独立 `agent-memory/` 行。GREEN 证明旧文件字节完整保留、`secrets.env` 规则仍生效、新规则精确一条，bootstrap 43/43 且 shellcheck/`bash -n` 通过。

R1 另带 4 个 MEDIUM 与 3 个 LOW advisory：gitleaks ignore fingerprint 绑定临时 snapshot 路径、scan 保留 live index staged 状态、clone sibling 未被外层 ignore、archive pipe 状态只看 tar，以及 lead-tree 诊断、ledger tmp 清理、Anthropic 指纹碰撞。它们按 `medium_low_findings_are_non_blocking_v1` 不阻断本 gate。

Fresh gate `7a82225f-0eb5-4712-a81c-25e7e36f82b8`、request `57d01b69-477e-4ef8-aa87-47d06e45eb7f` 在 reviewed head `b8756abcb2f83985a730c5a54253bdcd0fdd1152` 返回 `APPROVED`，无 HIGH / blocking finding。Fresh review 把私仓仍是旧 bootstrap 另列为一个 MEDIUM；其余 4 个 MEDIUM 与 3 个 LOW 同上。全部 advisory 已通过 report `70b446cd-ee4d-4a86-8958-d00859632a99` 回传 Lead，没有把非阻断项伪装成已修复。

## Review HIGH 的私仓同步闭环

Lead 在真实活仓有其他 Lead 未暂存写入的情况下，仅把已通过 TDD 的 `bootstrap.sh` 发布为私仓管理提交：

```text
FLYWHEEL_FIX_COMMIT=e975b7d270f2877a10d3e3ae657bdc87ea600cfc
BOOTSTRAP_FIX_SHA=f39602a8b59115fd7e5514f85e89e2cc9cc0bad7
REMOTE_MAIN=f39602a8b59115fd7e5514f85e89e2cc9cc0bad7
SOURCE_BOOTSTRAP_SHA256=60b7b320e0f13356eba05149ffd695f4c7060c4db00d9ae02cae24a3dc9401c0
REMOTE_BOOTSTRAP_SHA256=60b7b320e0f13356eba05149ffd695f4c7060c4db00d9ae02cae24a3dc9401c0
REMOTE_DIFF=bootstrap.sh only; 5 insertions, 1 deletion
```

原交接清单引用的修复完整 SHA 因 progress path-limited commit 重写而失效；Lead 没有放宽内容要求，而是先直接断言当前源码同时包含末字节检查和 `\nagent-memory/\n` 分支，再保持余下 staged-scope、tree-diff、扫描与 push 检查不变。实施 runner 随后独立确认当前等价修复提交、源码/远端文件哈希、远端 `main` 和单文件 diff。GitHub Actions `Lead memory guard` 对管理提交通过：[run 33822888556](https://github.com/xrliAnnie/lead-memory/actions/runs/33822888556)。因此 fresh review 的“私仓仍是旧 bootstrap” advisory 已闭环；剩余 4 个 MEDIUM 与 3 个 LOW 仍明确保留为非阻断 advisory。

发布前后 Lead 均未 add/commit 其他 Lead 的未暂存记忆；Lead 返回的发布后原样状态为：

```text
 M flywheel-eng-lead/MEMORY.md
 M flywheel-product-lead/feedback-no-assertions-ahead-of-evidence.md
 M flywheel-product-lead/feedback-read-runner-live-state-not-your-inbox.md
?? flywheel-eng-lead/reference_borrowed_slot_label_is_not_ownership.md
```

这些行不属于本单管理提交，由 A2 后续同步；runner 未读取其内容。

## PR CI 回归与重验闭环

PR [#1064](https://github.com/xrliAnnie/flywheel/pull/1064) 的首次完整 run `33824307596` 在 Linux 的 `Script Tests 4/4` 失败。完整日志显示 guard 56/56 已跑完，但 hooks 在 fresh clone 前由测试夹具创建的 bare origin 仍把 `HEAD` 指向宿主默认的 `master`；clone 因此没有 checkout，随后向不存在的 `sub-lead/MEMORY.md` 写入而退出。该 `bash -e` step 在第一处失败后没有执行 bootstrap、scan 或 workflow，所以此前不能拿本地绿灯冒充这三套的 CI 证据。

这组 suite 是本分支新增，`origin/main` 没有同名文件，因此不存在可执行的 main 同套件基线；CI 日志与 QA 的显式 `init.defaultBranch=master` 对照共同把 hooks 问题定为本分支台架可移植性回归。TDD 先把 hooks bare origin 明确初始化为 `master`，复现 fresh clone 无 checkout 的失败，再由 `14df710e937c7e3ff777200ac87049a954ed4c30` 明确设置并断言 remote `HEAD=refs/heads/main`。

Lead 同时要求把 bootstrap 套件的 clone 与 first-import 两个 bare origin 固定为 `main`，由 `9dcf5d393dbc85eed50ae229deabcb63714cf959` 完成。Fresh review 随后用 pre-change `5f88034b0` 做了精确 `master` 对照，两处仍为 43/43：clone origin 在实际 clone 前本来就显式重设 `HEAD=main`，first-import origin 从不被 clone，只按 `refs/heads/main` push/查询。因此这两处是防御性显式化，不是已复现的回归；新增断言只防未来夹具重构重新引入宿主依赖。产品脚本原本也显式选择 `main`，产品行为没有改动。

修复后，PR run `33825611501` attempt 2 在 head `5f88034b0db9333bc4b3642201687c8eae23dcc1` 全绿，`Script Tests 4/4` 实际跑到 guard、hooks、bootstrap、scan 和 workflow 结束，而不是只看 job 汇总状态。最终两个 bootstrap 夹具修复后的 code head `9dcf5d393dbc85eed50ae229deabcb63714cf959` 又在本地通过 hooks 24/24、bootstrap 45/45、guard 56/56、scan 21/21、real-scan、workflow 与 CI structure。对应最终 code-head PR run [33827395370](https://github.com/xrliAnnie/flywheel/actions/runs/33827395370) 全绿；`Script Tests 4/4` 的日志实际打印 guard `RESULTS: 56 passed`、真 gitleaks hooks `24 passed`、bootstrap `45 passed`、真 gitleaks scan `22 passed`，随后 workflow 明确输出 `lead-memory guard workflow is pinned, read-only, and fail-closed`。因此四套都确实执行到结尾。

最终 code head 的精确全仓门禁：`pnpm lint` exit 0（仅既有 warning），`pnpm -r build` exit 0，七组专项全部 exit 0。实施 resident 上的 `pnpm test:packages:run` 仍可复现未改的 Terminal.app 两测试因 AppleEvents `Connection Invalid` 失败；但 QA 在同机独立两轮令该文件 2/2、core 221/221 全绿，PR Unit jobs 也全绿。因此撤回“稳定已知 Terminal 基线失败”的表述：这只是本 resident 执行上下文的现象，不能作为后续挡箭牌。QA 的完整 package 命令实际仅在既有 `packages/flywheel-comm` 的 `qa-result.realgit.test.ts`（`FLY-1686 real Git push attestation`）与 `founder-review.test.ts`（`binds authority to HTML blobs`）失败；本分支在 `packages/` 下改动为 0、两文件均已存在于 main、PR Unit jobs 全绿，故记录为与本单无关的执行宿主现象。此前一次 config census 5 秒 timeout 本轮不复现，也不再列为已知失败。

最终 head 的 request-driven code review 会重新注册；不能沿用 code 变更前的 APPROVED。head `5f88034b0db9333bc4b3642201687c8eae23dcc1` 的中间 fresh review 已 `APPROVED` 且无 blocking finding，仅用于证明第一处 CI 夹具修复没有引入新 HIGH。

## 正确 clone 入口实跑与活状态顶换返工

此前的一次性 fresh clone 只在临时目录验证了仓库快照、12 夹内容和随 clone 带下来的护栏；它完全不触碰 `~/.claude/agent-memory`，因此**不等价于** `bootstrap.sh --clone` 对 canonical live path 的换位路径。此前“fresh clone 等价验收”的措辞不成立：本轮前正确入口从未真实执行过，这正是旧实现的活状态顶换副作用没有被发现的原因。

2026-09-04，Lead 在已有 Lead 正运行的机器上真实执行正确入口，旧脚本 rc=0，并逐字输出：

```text
lead-memory-bootstrap: cloned /Users/xiaorongli/.claude/agent-memory
lead-memory-bootstrap: previous directory preserved at /Users/xiaorongli/.claude/agent-memory.pre-clone-20260904T033324Z-210
```

这**不是数据丢失**：旧目录被完整保留在上述 `agent-memory.pre-clone-20260904T033324Z-210`，这个原有设计是正确的。但 canonical live path 被导入时的仓库快照顶换，正在运行的 Lead 不会看到提醒：clone 版为 557 个文件，换位前 live 版为 566 个；当晚新增的 `reference_codex_login_status_is_not_a_credential_probe.md` 不在 clone 版，当晚对 `feedback_quiet_wait_kills_codex_body.md` 和 `reference_claude_accounts_roster.md` 的追加也不在。Lead 随即手工换回并逐项核对 566 个文件、上述新文件与追加全部在位，确认零丢失；用于诊断的 clone 件另留在 `~/.claude/agent-memory.clone-artifact-<时间戳>`。

提交 `c0f2611d4` 以严格 TDD 补上这一个护栏，不改变备份或 swap rollback 设计，也不自动合并两棵树、更没有新增 bypass 旋钮：validated clone 与既有目录（忽略根 `.git`）内容不同就保守视为“可能含更新 live state”，在任何 `mv` 前打印 WARNING、预告精确备份路径，并要求输入精确 `REPLACE`；EOF 或其他输入会删除临时 clone、保持 live 目录和外层仓零改动。RED 先复现旧脚本无输入仍 rc=0 并顶换；GREEN 证明无确认拒绝、显式确认才换位且原目录仍保留；mutation 阳照只中和这一行确认调用后，再次无 WARNING/无确认地把 live path 换成仓库快照，同时旧目录仍在备份，证明测试确实锁住本次缺口。该新护栏在隔离目录验证，不把它写成又一次 canonical live-path 实跑。

提交 `869351e2d` 又把比较器异常单独钉死：测试用退出 75 的 `python3` stub 触发非“相同/不同”的比较错误，断言脚本在确认提示和任何换位前 fail-closed，live 哨兵仍在且不遗留 clone/backup 临时目录。最终 bootstrap 套件为 56/56，`shellcheck`、`sh -n`、`bash -n` 与 `git diff --check` 均通过。

## 正确入口返工头的门禁与评审

返工 code head `6b3493ede463de7f8452f45df81584f3e5c945eb` 上，实施节点重新执行了精确全仓门禁：

```text
pnpm lint: exit 0（仅既有 warning）
pnpm -r build: exit 0（22/23 workspace projects）
pnpm test:packages:run: exit 1
  packages/core: 219/221 passed
  only failures: test/tmux-viewer.macos.test.ts (2)
  host evidence: Terminal.app AppleEvents Connection Invalid / osascript syntax error
test-lead-memory-bootstrap.test.sh: 56/56
test-lead-memory-guard.test.sh: 56/56
test-lead-memory-hooks.test.sh: 23/23
test-lead-memory-scan-real.test.sh: PASS
test-lead-memory-scan.test.sh: 21/21
test-lead-memory-workflow.test.sh: PASS
ci-structure.test.sh: PASS
```

PR run [33835489090](https://github.com/xrliAnnie/flywheel/actions/runs/33835489090) 的 `Script Tests 4/4 — cmux repair + Lead memory` 通过，其他三组 shell suites、Quick Gate、NPM、Unit light 和三个 teamlead unit shards 也全部通过。唯一失败为 `Unit (heavy)` 的 5 个 edge-worker Blueprint 字节快照：它们都收到当前 `main` 的 FLY-2222 新句 `Treat an inbox pending summary as unread runner-mailbox traffic...`，而 `#1067` 未同步更新 FLY-1188/FLY-2147 的 pre-memory、off、forced-shared 与 unsupported-backend golden fixtures。本分支相对 merge-base 在 `packages/` 下改动为 0。Lead 已独立复核：#1067 的基线早于 #1056 合入，故 #1067 当时自身 13/13 绿却看不到后加夹具；这是 #1067 × #1056 的语义合并冲突，不是本分支引入、也不是执行环境问题。修复已单列 FLY-2318，要求先证明新提示词语义正确再更新 golden；Lead 明确裁决本单不改这些逐字节守卫、不需等待 main 变绿即可交 QA。

request-driven cross-family code review gate `42737643-2ebe-4020-8021-4623e48fbec6` 在上述 head 返回 `APPROVED`，无 HIGH / blocking finding。它把私仓尚未带上新 confirmation bootstrap/README 列为 MEDIUM deployment-sync advisory；这不是被冒充为已闭环的源码问题：Lead 已明确顺序为 implementation → 独立 QA（含 mutation 阳照）→ Lead 才发布并验证两个文件哈希，因此实施节点没有提前同步私仓。其余 MEDIUM/LOW 仍是下节已披露的非阻断延期项，全部经正式 report 通道回传。

## 非阻断 advisory 明示决定

- **clone 兄弟/备份目录未被外层 ignore**：本单决定不改。扩大外层 ignore 合同会改变备份保留和清理语义，超出已批准的首搬范围。影响是 `agent-memory.pre-clone-*` 可能在外层 config 仓显示为 untracked，并被粗放的 `git add -A` 带入；follow-up 完成前操作者必须避免该命令。
- **gitleaks ignore 指纹嵌入临时 snapshot 路径**：本单决定不改。真实首搬为 0 命中，不需要例外；正确修复需设计稳定 snapshot 路径或指纹规范化。影响是未来 false positive 不能按当前文档持久 allowlist，publish 会持续 fail-closed。
- **扫描把 live index 留在 staged**：本单决定不改。首搬已经完成，改成 private index 会重写扫描/首搬事务边界。影响是未来两阶段 prepare 期间可能暂存全部 Lead 目录，使普通 Lead commit 在 publish 或显式清理 index 前被拒绝。
- **archive pipeline 未证明完整 path-set**：本单决定不改。当前已发布树已由独立 fresh clone 重建并完成双扫描；通用修复需新增全量 extracted-path equality。影响是未来若 archive producer 截断而 tar consumer 仍退出 0，可能把不完整 snapshot 的扫描 PASS 关联到完整 tree。

以上四项均已回报 Lead，并按 `medium_low_findings_are_non_blocking_v1` 为非阻断；其中能失败的流程保持 fail-closed，不把延期写成已修复。仓内包含个人标识和内部运行信息，私有性是永久要求，不是临时或可选配置。

## 验收矩阵

| PRD 验收 | 状态 | 证据 |
| --- | --- | --- |
| 另一台机器拉下来见 12 夹同内容 | 通过（两类证据分开，不再称等价） | 临时 fresh clone checkout `IMPORT_SHA` 证明 12 夹齐、tracked 1156、source/clone `ls-tree` 哈希相同、两端重建合成树 == 终扫树；它不覆盖 canonical live-path swap。正确 `bootstrap.sh --clone` 已由 Lead 在已有 live 目录的本机实跑并发现上述顶换，随后补显式确认护栏；真第二台机器仍由 founder 后续执行 |
| 任一 Lead 读得到别家 | 通过 | clone 与 source 均实读 `sub-lead/MEMORY.md` 到 `/dev/null` |
| 写别家写不进 | 通过 | 一次性 fresh clone 的 commit、`--no-verify`、pre-push、CI `check-range` 全部拒绝，远端 SHA 不变；source=clone=live 的四 hook 哈希逐项相等，自家正向写与清理均过 CI |
| 无权限者打不开 | 通过 | 首搬后鉴权 API `private=true`且默认分支 `main`；无凭据 HTTP=`404` |
| 扫描结果逐条有处理记录 | 通过 | publish 终扫真工具 0/0、阳性映射 8/8+4/4；仓内台账 36/36 当次 blob 已由 Lead 亲审并固化，`status=PASS` |

## 尚待回填

- PR `#1064` 最终 milestone head 的 fresh code review；其 `Unit (heavy)` 若仍继承 #1067 × #1056 的 5 条 golden 冲突，则按 Lead 裁决如实关联 FLY-2318，不冒充本单绿灯
- 独立 QA 通过后，由 Lead 发布新 confirmation bootstrap/README 到私仓并验证哈希；实施节点不提前发布
- 真第二台机器由 founder 按 README 拉取；本单的临时 fresh clone 与 Lead 的 canonical-path 实跑是两类不同证据，不再称前者等价覆盖后者

## 诚实边界

- 目录写权是事故护栏和审计，不是 GitHub 服务端安全边界。同一账号下，故意使用 `--no-verify` 或冒充 admin 的进程仍可能绕过本地钩子；CI 能标红已推历史但不能让已到 GitHub 的字节倒流。
- runner 继承其 Lead 的 `FLYWHEEL_LEAD_ID`，护栏分不出 Lead 与该 Lead 的 runner。
- 扫描只能证明两把工具当前规则集和人工抽样所覆盖的范围，不能证明私有记忆里不存在任何敏感内容。
- 首搬后的新增记忆交给 FLY-2132 A2；本单不实现定时同步。
