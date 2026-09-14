# FLY-2533 评审与后续建议 — 调研
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: plan.md

## 生效评审

有效 reviewVerdict=APPROVED；reviewerVerdict=APPROVED；round=1。questionId=`5cf7c92d-de7b-4b12-a705-6019ee33bb60`，requestId=`2be30402-f92f-4f3d-95c2-188118168153`。计划 blob=`72f93b81db8008ad8eb4c79cd5e3132b5de40c70`。

本记录不修改批准计划；以下均为服务端标定的非阻断 MEDIUM/LOW advisories，供 Lead 决定后续。评审涉及生产拓扑的判断是 reviewer 的审计证据，本设计节点未执行生产核查。

## Follow-ups

### MEDIUM · stale-managed-block-fail-close

同类型托管块只要正文不是当前版本就拒绝新物化，影响面过大。

§4.3 规定：托管块类型正确、结构完整，但正文是旧版本时，也要拒绝新物化。这没有带来安全收益。当前协议本来就会被加到最前面，所以把这个块剥掉再前置新协议，结果和正常路径完全一样。拒绝反而会让所有带旧副本的手册在协议改一个字之后全部停摆。已知的旧副本来源有两个：test-deploy.sh:1204–1207 会把 REPO_ROOT 的节点文件复制进 slot，还有任何复制过 Flywheel 节点文件的项目。建议：类型正确、标记配对完整的块一律剥离后前置当前协议；只有类型错、重复、嵌套或损坏时才拒绝。C 判据要求的缺失、空文件和损坏拒绝不受影响。

### MEDIUM · live-checkout-assets-not-atomic

生产拓扑下协议资产在 checkout 里实时读取，“原子切换 / merge 不等于上线”不成立。

已核实部署方式。~/Library/LaunchAgents/com.flywheel.bridge.plist 运行的是 ~/Dev/flywheel/scripts/flywheel-bridge-wrapper.sh，~/.flywheel/bin 也软链到 ~/Dev/flywheel/packages/*/dist。projects.json 里 flywheel 的 projectRoot 就是这个 checkout。loader 通过 import.meta.url 定位到 packages/teamlead/phase-protocols，而且每次物化都重新读，不做缓存。节点投影也放在同一个 checkout。结果有三点：(1) update-flywheel.sh 的 ff-only merge，或者合并后手动 git pull，会让协议正文在 restart 之前就对旧 dist 生效，绕过了 §10 所说的正常部署窗口；(2) git 写文件时会有一个短窗口，源文件和投影不一致或文件暂时缺失，这时新派发会被 409 拒绝；(3) §5.1 的“代码和资源同一版本、原子切换”在这个拓扑下无法保证。失败方向都是 fail-closed，不会 fail-open，所以不阻断。建议在计划里如实写明这个拓扑。另外二选一：进程启动时加载一次并校验（重启才生效），或者 build 时把协议生成进 dist；同时说明 C 判据的“移走文件”该怎么测。

### MEDIUM · same-file-check-registry-and-agent-file-gap

qa/implement 同文件检查只覆盖 legacy ic-roster。

§6 只在 loadLegacyProjectRoster 里比较 realpath 和 dev+ino。另外两条同样能让 qa 与 implement 解析到同一文件的路径没有覆盖：一是 registry overlay 项目，resolveProjectRegistry 会读 project/.flywheel/agents/registry.yaml；二是 manifest 或模板 override 里显式写的 agent_file（workflow-run-snapshot.ts 的 agent_file 分支）。D 的本意是隔离文件身份，建议在 buildGeneralizedWorkflowRunSnapshot 里按已解析的 target realpath 和 dev+ino 统一检查一次；如果只做 roster，就在计划里明确写成“已知限制”。已核实：生产六个项目目前都没有同文件配置，也没有超过 30k 的 .flywheel 手册，所以上线本身不会打断现有项目。

### MEDIUM · test-packages-run-opens-terminal

§10 要求的 pnpm test:packages:run 会在 macOS 上跑真 Terminal.app 测试。

计划说不跑根目录 pnpm test 就能避开 tmux viewer，这不对。根 package.json 里 test:packages:run 等于 pnpm --filter './packages/*' test:run，会跑到 packages/core 的 vitest run --passWithNoTests。packages/core/vitest.config.ts 没有排除 **/tmux-viewer.macos.test.ts（只有 voice-codex 的配置排除了）。这个测试会真实调用 osascript 和 Terminal.app，在 founder 屏幕上开窗口或弹出授权提示。建议把命令改成显式排除该文件，或逐包 --filter 运行并排除 core 的这个测试。

### LOW · protocol-minimal-vs-extraction-destination

最小协议正文与“抽取条款不得丢失”之间，缺少条款去向判据。

§4.2 给出的是最小正文，§4.3 又要求迁移表逐条列出旧条款去向，但没说明判据：什么情况下条款并入唯一协议源（会作用于所有项目），什么情况下留在 Flywheel 领域手册。建议补一条可执行规则：只有不依赖 Flywheel 仓库、529、ship-report 细节的平台条款才进协议源。否则实现时容易把 Flywheel 专属要求注入到其他项目。

### LOW · validation-doc-header-mislabeled

validation.md 标题写成了“调研”。

标题是“# FLY-2533 快照阶段协议 — 调研”，但内容是设计验证和评审记录，与 research.md 重名，容易混淆。

## 结构化回执

```json
{
  "reviewVerdict": "APPROVED",
  "reviewerVerdict": "APPROVED",
  "requestId": "2be30402-f92f-4f3d-95c2-188118168153",
  "round": 1,
  "findings": [
    {
      "id": "stale-managed-block-fail-close",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 121,
      "title": "同类型托管块只要正文不是当前版本就拒绝新物化，影响面过大",
      "detail": "§4.3 规定：托管块类型正确、结构完整，但正文是旧版本时，也要拒绝新物化。这没有带来安全收益。当前协议本来就会被加到最前面，所以把这个块剥掉再前置新协议，结果和正常路径完全一样。拒绝反而会让所有带旧副本的手册在协议改一个字之后全部停摆。已知的旧副本来源有两个：test-deploy.sh:1204–1207 会把 REPO_ROOT 的节点文件复制进 slot，还有任何复制过 Flywheel 节点文件的项目。建议：类型正确、标记配对完整的块一律剥离后前置当前协议；只有类型错、重复、嵌套或损坏时才拒绝。C 判据要求的缺失、空文件和损坏拒绝不受影响。",
      "findingKey": "stale-managed-block-fail-close"
    },
    {
      "id": "live-checkout-assets-not-atomic",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 129,
      "title": "生产拓扑下协议资产在 checkout 里实时读取，“原子切换 / merge 不等于上线”不成立",
      "detail": "已核实部署方式。~/Library/LaunchAgents/com.flywheel.bridge.plist 运行的是 ~/Dev/flywheel/scripts/flywheel-bridge-wrapper.sh，~/.flywheel/bin 也软链到 ~/Dev/flywheel/packages/*/dist。projects.json 里 flywheel 的 projectRoot 就是这个 checkout。loader 通过 import.meta.url 定位到 packages/teamlead/phase-protocols，而且每次物化都重新读，不做缓存。节点投影也放在同一个 checkout。结果有三点：(1) update-flywheel.sh 的 ff-only merge，或者合并后手动 git pull，会让协议正文在 restart 之前就对旧 dist 生效，绕过了 §10 所说的正常部署窗口；(2) git 写文件时会有一个短窗口，源文件和投影不一致或文件暂时缺失，这时新派发会被 409 拒绝；(3) §5.1 的“代码和资源同一版本、原子切换”在这个拓扑下无法保证。失败方向都是 fail-closed，不会 fail-open，所以不阻断。建议在计划里如实写明这个拓扑。另外二选一：进程启动时加载一次并校验（重启才生效），或者 build 时把协议生成进 dist；同时说明 C 判据的“移走文件”该怎么测。",
      "findingKey": "live-checkout-assets-not-atomic"
    },
    {
      "id": "same-file-check-registry-and-agent-file-gap",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 168,
      "title": "qa/implement 同文件检查只覆盖 legacy ic-roster",
      "detail": "§6 只在 loadLegacyProjectRoster 里比较 realpath 和 dev+ino。另外两条同样能让 qa 与 implement 解析到同一文件的路径没有覆盖：一是 registry overlay 项目，resolveProjectRegistry 会读 project/.flywheel/agents/registry.yaml；二是 manifest 或模板 override 里显式写的 agent_file（workflow-run-snapshot.ts 的 agent_file 分支）。D 的本意是隔离文件身份，建议在 buildGeneralizedWorkflowRunSnapshot 里按已解析的 target realpath 和 dev+ino 统一检查一次；如果只做 roster，就在计划里明确写成“已知限制”。已核实：生产六个项目目前都没有同文件配置，也没有超过 30k 的 .flywheel 手册，所以上线本身不会打断现有项目。",
      "findingKey": "same-file-check-registry-and-agent-file-gap"
    },
    {
      "id": "test-packages-run-opens-terminal",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 281,
      "title": "§10 要求的 pnpm test:packages:run 会在 macOS 上跑真 Terminal.app 测试",
      "detail": "计划说不跑根目录 pnpm test 就能避开 tmux viewer，这不对。根 package.json 里 test:packages:run 等于 pnpm --filter './packages/*' test:run，会跑到 packages/core 的 vitest run --passWithNoTests。packages/core/vitest.config.ts 没有排除 **/tmux-viewer.macos.test.ts（只有 voice-codex 的配置排除了）。这个测试会真实调用 osascript 和 Terminal.app，在 founder 屏幕上开窗口或弹出授权提示。建议把命令改成显式排除该文件，或逐包 --filter 运行并排除 core 的这个测试。",
      "findingKey": "test-packages-run-opens-terminal"
    },
    {
      "id": "protocol-minimal-vs-extraction-destination",
      "severity": "LOW",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 105,
      "title": "最小协议正文与“抽取条款不得丢失”之间，缺少条款去向判据",
      "detail": "§4.2 给出的是最小正文，§4.3 又要求迁移表逐条列出旧条款去向，但没说明判据：什么情况下条款并入唯一协议源（会作用于所有项目），什么情况下留在 Flywheel 领域手册。建议补一条可执行规则：只有不依赖 Flywheel 仓库、529、ship-report 细节的平台条款才进协议源。否则实现时容易把 Flywheel 专属要求注入到其他项目。",
      "findingKey": "protocol-minimal-vs-extraction-destination"
    },
    {
      "id": "validation-doc-header-mislabeled",
      "severity": "LOW",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/validation.md",
      "line": 1,
      "title": "validation.md 标题写成了“调研”",
      "detail": "标题是“# FLY-2533 快照阶段协议 — 调研”，但内容是设计验证和评审记录，与 research.md 重名，容易混淆。",
      "findingKey": "validation-doc-header-mislabeled"
    }
  ],
  "advisories": [
    {
      "id": "stale-managed-block-fail-close",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 121,
      "title": "同类型托管块只要正文不是当前版本就拒绝新物化，影响面过大",
      "detail": "§4.3 规定：托管块类型正确、结构完整，但正文是旧版本时，也要拒绝新物化。这没有带来安全收益。当前协议本来就会被加到最前面，所以把这个块剥掉再前置新协议，结果和正常路径完全一样。拒绝反而会让所有带旧副本的手册在协议改一个字之后全部停摆。已知的旧副本来源有两个：test-deploy.sh:1204–1207 会把 REPO_ROOT 的节点文件复制进 slot，还有任何复制过 Flywheel 节点文件的项目。建议：类型正确、标记配对完整的块一律剥离后前置当前协议；只有类型错、重复、嵌套或损坏时才拒绝。C 判据要求的缺失、空文件和损坏拒绝不受影响。",
      "findingKey": "stale-managed-block-fail-close"
    },
    {
      "id": "live-checkout-assets-not-atomic",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 129,
      "title": "生产拓扑下协议资产在 checkout 里实时读取，“原子切换 / merge 不等于上线”不成立",
      "detail": "已核实部署方式。~/Library/LaunchAgents/com.flywheel.bridge.plist 运行的是 ~/Dev/flywheel/scripts/flywheel-bridge-wrapper.sh，~/.flywheel/bin 也软链到 ~/Dev/flywheel/packages/*/dist。projects.json 里 flywheel 的 projectRoot 就是这个 checkout。loader 通过 import.meta.url 定位到 packages/teamlead/phase-protocols，而且每次物化都重新读，不做缓存。节点投影也放在同一个 checkout。结果有三点：(1) update-flywheel.sh 的 ff-only merge，或者合并后手动 git pull，会让协议正文在 restart 之前就对旧 dist 生效，绕过了 §10 所说的正常部署窗口；(2) git 写文件时会有一个短窗口，源文件和投影不一致或文件暂时缺失，这时新派发会被 409 拒绝；(3) §5.1 的“代码和资源同一版本、原子切换”在这个拓扑下无法保证。失败方向都是 fail-closed，不会 fail-open，所以不阻断。建议在计划里如实写明这个拓扑。另外二选一：进程启动时加载一次并校验（重启才生效），或者 build 时把协议生成进 dist；同时说明 C 判据的“移走文件”该怎么测。",
      "findingKey": "live-checkout-assets-not-atomic"
    },
    {
      "id": "same-file-check-registry-and-agent-file-gap",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 168,
      "title": "qa/implement 同文件检查只覆盖 legacy ic-roster",
      "detail": "§6 只在 loadLegacyProjectRoster 里比较 realpath 和 dev+ino。另外两条同样能让 qa 与 implement 解析到同一文件的路径没有覆盖：一是 registry overlay 项目，resolveProjectRegistry 会读 project/.flywheel/agents/registry.yaml；二是 manifest 或模板 override 里显式写的 agent_file（workflow-run-snapshot.ts 的 agent_file 分支）。D 的本意是隔离文件身份，建议在 buildGeneralizedWorkflowRunSnapshot 里按已解析的 target realpath 和 dev+ino 统一检查一次；如果只做 roster，就在计划里明确写成“已知限制”。已核实：生产六个项目目前都没有同文件配置，也没有超过 30k 的 .flywheel 手册，所以上线本身不会打断现有项目。",
      "findingKey": "same-file-check-registry-and-agent-file-gap"
    },
    {
      "id": "test-packages-run-opens-terminal",
      "severity": "MEDIUM",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 281,
      "title": "§10 要求的 pnpm test:packages:run 会在 macOS 上跑真 Terminal.app 测试",
      "detail": "计划说不跑根目录 pnpm test 就能避开 tmux viewer，这不对。根 package.json 里 test:packages:run 等于 pnpm --filter './packages/*' test:run，会跑到 packages/core 的 vitest run --passWithNoTests。packages/core/vitest.config.ts 没有排除 **/tmux-viewer.macos.test.ts（只有 voice-codex 的配置排除了）。这个测试会真实调用 osascript 和 Terminal.app，在 founder 屏幕上开窗口或弹出授权提示。建议把命令改成显式排除该文件，或逐包 --filter 运行并排除 core 的这个测试。",
      "findingKey": "test-packages-run-opens-terminal"
    },
    {
      "id": "protocol-minimal-vs-extraction-destination",
      "severity": "LOW",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/plan.md",
      "line": 105,
      "title": "最小协议正文与“抽取条款不得丢失”之间，缺少条款去向判据",
      "detail": "§4.2 给出的是最小正文，§4.3 又要求迁移表逐条列出旧条款去向，但没说明判据：什么情况下条款并入唯一协议源（会作用于所有项目），什么情况下留在 Flywheel 领域手册。建议补一条可执行规则：只有不依赖 Flywheel 仓库、529、ship-report 细节的平台条款才进协议源。否则实现时容易把 Flywheel 专属要求注入到其他项目。",
      "findingKey": "protocol-minimal-vs-extraction-destination"
    },
    {
      "id": "validation-doc-header-mislabeled",
      "severity": "LOW",
      "file": "engineering/doc/FLY-2533-snapshot-phase-protocol/validation.md",
      "line": 1,
      "title": "validation.md 标题写成了“调研”",
      "detail": "标题是“# FLY-2533 快照阶段协议 — 调研”，但内容是设计验证和评审记录，与 research.md 重名，容易混淆。",
      "findingKey": "validation-doc-header-mislabeled"
    }
  ],
  "settled": [],
  "policyNote": "medium_low_findings_are_non_blocking_v1"
}
```
