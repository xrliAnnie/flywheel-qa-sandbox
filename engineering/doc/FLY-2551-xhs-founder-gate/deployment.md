# FLY-2551 离线部署定义 — 实施计划补充
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-15
基于: plan.md、design-correction.md

## 生成可审阅 bundle

构建 teamlead 后，在普通工作目录运行离线入口。两个 source 文件只包含根策略及 provider 策略 JSON，不能放 token/key 的内容；策略内仅引用受保护文件路径。`--policy-path` 是未来部署的绝对策略路径；output 的父目录必须已存在，output 自身必须不存在。

```sh
node packages/teamlead/dist/xiaohongshu-write/deployment-entry.js \
  --policy-source /path/to/reviewed-authority.json \
  --provider-source /path/to/reviewed-provider.json \
  --policy-path '/Library/Application Support/Flywheel/Xhs/authority.json' \
  --output-dir /private/tmp/xhs-reviewed-deployment
```

生成 `com.flywheel.xhs-authority.plist` 与 `requirements.json`，本地 bundle 目录0700、文件0600。生成器执行严格 schema、跨服务绑定、provider 原始字节摘要和路径权限冲突检查；不读取 key/token、不建账号、不执行 chown/chmod、不签 acceptance、不运行 launchctl。输入 source 限64KiB、UTF-8、普通文件且禁止符号链接；输出禁止覆盖已有 bundle。

## 部署主体与路径

requirements 是待核对的部署要求，不是自动修改主机的脚本。目录/文件 mode 在 JSON 中是十进制整数。UID/GID 必须与根策略数字和实际 `_flywheel_xhs` 账号一致；模型用户不能在 serviceGid 内，必须在 ingressGid 内。专用账号不得有登录、sudo、admin 或额外共享组。

- plist 安装路径固定 `/Library/LaunchDaemons/com.flywheel.xhs-authority.plist`，root:wheel0644，内容摘要列入 requirements。
- ProgramArguments 固定为已 pin 的 launcher、Node、entry、`--config`、部署策略路径。UserName/GroupName 固定 `_flywheel_xhs`，Umask 十进制63（八进制0077），ProcessType Background。launcher 再清空继承环境，只保留固定 PATH/LANG/LC_ALL。
- launchd 创建 Ingress/Authority 两个 passive stream socket；两者 root-owned0660，分别用 ingressGid/serviceGid。Authority 父目录 root:serviceGid0750，所有祖先 root 不可写。public ingress 父目录 root0755。内核 peer 固定 root 的依据见 design-correction.md；接受连接的一端仍检查真实客户端 UID。
- provider 自建 socket 的父目录为 service0700，必须与 root-owned fd4 目录分开。生成器拒绝同目录的权限冲突。state/epochs/journal/media/profiles/artifacts/keys 等目录为 service0700，私有文件0600。
- Node、JS、peer helper、launcher、provider、Chromium、guardian、boundaryProbe、ffmpeg、ffprobe 都列出根不可变安装路径和摘要。guardian 从 fork `guardian/xhs-browser-guardian.c` 编译；不允许替换成模型目录里的程序。
- 运行时的其他支持文件（Node 依赖、静态资源、原生模块、Chromium bundle 等）同样需要完整的不可变安装闭包。此生成器只列出策略直接 pin 的入口，不替代完整 artifact 安装/核验。

## 验收与启用边界

bundle 不证明机器已安装，也不授权启用。实际安装与启用仍由受授权的 host/QA/ship 流程承担；本次 implement 未执行 root 操作。

验收须独立证明实际专用 UID/组、根不可变路径、fd3/fd4 为 launchd 继承、非策略路径拒绝、serviceGid 外对 fd4 连接得到 EACCES、专用身份的 headless/fake-platform 六写、guardian 在 provider 退出后的精确清理，以及没有秘密进入模型 trace。完整门清单继续以 plan.md 和 acceptance-audit.md 为准。user_profile 的已批准暂缓不能记为激活验收通过。

两个 acceptance 文件在 requirements 中仅是待核验文件；生成器不会创建它们。通过声明或人工填写 passed=true 不能替代可执行边界验收。首次验收/签名引导与完整安装闭包仍需要后续可执行材料，当前 bundle 不构成完整 installer 或 host acceptance。

## 初始 synthetic 文件探针入口

构建后可由被验收的实际 model UID 执行固定入口：

```sh
node packages/teamlead/dist/xiaohongshu-write/boundary-probe-entry.js \
  --probe file-authority \
  --fixture /private/var/db/flywheel-xhs-qa/<64hex-nonce>
```

这条命令当前只输出八项 unsigned 文件操作观察值：key/cookie/ledger 读、ledger 写打开、store rename/symlink、policy/binary 写打开。仅 EACCES/EPERM 算权限拒绝，ENOENT 和意外成功均失败；不读取文件内容、不截断或写入字节。fixture 内固定名称为 state/{permit.synthetic,cookie.synthetic,ledger.synthetic,artifacts} 及 policy.synthetic/binary.synthetic。若权限配置错误，rename/symlink 可能改变该 synthetic fixture，需由独立安装器在正向控制中识别；探针不自动清理。

fixture.json 必须由可信安装器提供且所有祖先 root 不可写，内容为严格对象：schemaVersion=1，purpose=flywheel-xhs-synthetic-boundary，nonce 与目录名一致，serviceUid/modelUid 为不同正整数。state 必须 serviceUid 所有0700。未知字段、生产路径、用户可写标记均拒绝。

本入口不创建 fixture、不启动服务、不签名。单凭此命令 exit0 不构成 acceptance：可信安装器仍须独立确认这些非空 synthetic 文件真实存在并可被服务身份访问，随后采集其余主体×探针矩阵。当前没有取得这些 host 正向控制或真实平台证据。

## 文件探针正向控制

可信安装器应在模型拒绝探针的前后，分别以实际 serviceUid 运行同一独立入口 `--probe file-control --fixture <固定QA根>`。root 或 modelUid 直接运行这项控制会被拒绝。控制逐项读取五个固定文件，检查内容严格等于 `flywheel:xhs:synthetic:<basename>:<nonce>\n`（末尾是真实换行），不是任意非空字节：

- serviceUid0700 的 state 目录仅包含 permit.synthetic、cookie.synthetic、ledger.synthetic、artifacts；前三个文件 serviceUid0600，artifacts 是 serviceUid0700 空目录。
- 根目录内 policy.synthetic 与 binary.synthetic 由 root 所有，祖先不可写，内容使用相同固定 sentinel 格式。

输出只包含摘要、UID、nonce、marker 摘要、state/dev/inode 和各文件的身份及摘要。控制拒绝缺失、空白、非 synthetic 内容、读取期间的 inode/元数据变化、非空 artifacts 或 rename/symlink 探针遗留项。模型拒绝探针也绑定同一 marker 摘要与 state 身份，并在操作间拒绝替换。

安装器必须自行执行前后控制并比较，不能接受模型提交的 stdout。当前代码尚未实现安装器调度、完整矩阵聚合或签名；这项命令也不证明 service 的真实 ledger/provider/浏览器已经运行。上述文件是固定的权限测试材料，不是任何真实账户凭证或生产数据库。

## 独立 authority-flow fixture launcher

同一独立 probe entry 现在支持 `--probe authority-flow --fixture <固定QA根>`。入口先执行 file-control，要求实际 serviceUid。可信安装器还必须预置 root-owned、不可写祖先的 `peer-helper`（由本仓 C source 构建），以及两个 serviceUid0700 空目录 `runtime`、`io`。helper 每次执行场景前重新校验摘要；不接受调用者提供命令、路径、账号或内容。

launcher 在 runtime 下排他创建 run-once，并写入/fsync run.json、run-once 和 runtime 目录后才运行八个固定场景。每个场景独占 case-0…case-7 目录保存真实 SQLite 与冻结媒体；成功、失败和中断记录都保留。后续调用发现 runtime 非空直接拒绝；没有按年龄接管或自动删除。由受授权的独立安装器/操作者检查并另行处理该 synthetic fixture。

为满足 macOS Unix socket 路径长度，所有串行场景使用固定 `io/i`（当前规范 nonce 根下101字节），不用深层 case 目录。io 的 UID/mode/dev/inode 和空目录状态在场景前后重验；handler/server 关闭后 socket 必须消失。文件权限控制在全套场景前后必须完全一致。

八个场景使用同一实际服务 UID 作 synthetic 客户端和服务端，输出明确 fixture_harness；它们不模拟跨 UID 隔离，也不代替真实 launchd fd3/fd4 接管。使用生产 handler、registry、preparation、cards、observer、store、executor 和 artifact store，Discord、provider及decoder是固定无网络 synthetic adapter。生产 authority-main 没有导入该入口或任何 acceptance bypass。没有 Go-provider/真实Chromium或平台动作，实际 root installer 仍需完成其他探针、不可变依赖闭包和独立签名。

## Root-only 固定身份探针 runner

新增 scripts/xhs/xhs-fixture-principal.c，构建并作为 root-owned0755 非setuid安装材料；本轮仅在临时目录编译/测试，未安装或以root执行。Lead53d7cd65-8418-4b85-9b55-ef7bac7d7340确认使用经典不可逆顺序 setgroups → setgid → setuid，exec前重读身份及组，任何不符拒绝。服务账号必须为 _flywheel_xhs、无登录shell且只有serviceGid；model保留本机账号数据库列出的真实全部组，不能通过删组伪造拒绝。

程序只接受两个非路径参数：service file-control、service authority-flow，或 model file-authority。真实UID和有效UID都必须root。所有路径/UID/GID只读固定 `/Library/Application Support/Flywheel/Xhs/fixture-runner.policy`；禁止argv/env传路径。策略是以下严格有序行格式，每行以换行结束，无额外行：

```text
version=1
service_uid=<dedicated UID>
service_gid=<dedicated primary GID>
model_uid=<actual model UID>
model_gid=<actual model primary GID>
node=<root installed Node path under /Library/Application Support/Flywheel/Xhs/>
node_sha256=<64 lowercase hex>
entry=<root installed boundary-probe-entry.js path under the same install root>
entry_sha256=<64 lowercase hex>
fixture=/private/var/db/flywheel-xhs-qa/<64 lowercase hex nonce>
```

策略/Node/entry/fixture的祖先必须root且不可组写或其他人写，禁止符号链接。Node/entry使用CommonCrypto SHA-256读取实际字节，与根策略pin比较；不依赖PATH里的hash工具。非macOS测量路径fail closed。安装器还必须校验runner本身和完整依赖闭包，并将该策略与reviewed部署配置绑定；此生成/调度仍未接线。

降权后stdin固定/dev/null，继承fd3及以上先枚举再全部关闭，环境仅PATH/LANG/LC_ALL，工作目录/，然后exec固定Node/entry和受限probe/fixture。程序不具备签名或安装功能。这里的model子进程也不能冒充真实Claude/Codex/Runner上下文：各上下文主机回执继续是独立矩阵缺项。

## Root synthetic fixture provisioning primitive

`provisionBoundaryFixture` 为后续可信安装器提供固定路径的创建操作；当前没有可供模型调用的 RPC 或生产入口。要求真实及有效 UID 都为 root，并在任何写入前校验固定安装目录、QA父目录的所有祖先为root且不可组/其他人写，以及已pin的peer helper实际字节。调用者必须先从根不可变部署配置取得身份和程序pin；本函数不接受生产凭据。

先排他创建固定 `fixture-runner.policy` 并fsync，再排他创建 nonce QA目录。该目录整个构建期间为root0700，子目录/文件通过打开的fd设置准确uid/gid/mode并fsync；只有全部synthetic数据、helper和marker持久化后，顶层才改为root0755供两个主体探针访问。state/artifacts/runtime/io为service0700，三个私有sentinel为service0600，policy/binary sentinel和marker为root0644，helper为root0555。没有从生产状态读取或复制cookie/key。

已存在的策略/fixture不会覆盖；任何失败都保留策略预约及部分目录，不清理、不按年龄接管、不自动重试。可信操作者需另行检查失败材料。测试将固定路径重定向到临时目录并模拟ownership，未执行root权限变更，不能当作主机验收。后续仍需接线固定入口、完整安装闭包测量、直接子进程采集及独立主机探针/签名。

## 可信调用者内的fixture编排

`runInstallerFixture` 接上provisioner和collector，要求root身份、固定安装路径pin并在每个native child前重新测量；只传递role/probe两个参数，清空环境，不使用shell，stdout/stderr各受128KiB限制，120秒超时杀死确切子进程。失败不重试，不释放或删除已有fixture。collector同时绑定provisioner返回的marker digest和state dev/inode，不能用另一套内部自洽观察代替本次fixture。

这是供独立可信安装入口调用的内部函数，尚未提供已安装root入口或完整依赖闭包证明。调用者须先验证其自身和所有依赖来自完整root不可变安装；只有入口pin不足以证明闭包。返回的hostAcceptance仍为false，不能直接签生产acceptance。本轮未运行任何root child。

## 完整文件树测量原语

`verifyInstalledTree` 接受须由可信bootstrap先认证的manifest原始字节，逐一测量root安装目录下的全部目录与文件。manifest schemaVersion=1，root为`/Library/Application Support/Flywheel/Xhs/`下的规范绝对目录；entries包含相对path、kind(directory/file)、精确mode；file另含size和sha256。文件/目录总数上限20000，manifest4MiB，单文件256MiB，总文件字节2GiB，路径深度32。空文件也校验sha256。

root及祖先、每个条目均必须root所有且不可组/其他人写；setuid/setgid/sticky、symlink、硬链接、特殊文件、重复/不规范相对路径、未列出的文件或空目录、缺项、内容或metadata变化均拒绝。完成读取后重验所有文件/目录metadata与目录清单。此格式要求安装树内没有符号链接；现有包含symlink的开发依赖树或浏览器bundle不能直接被当成已验收树，后续安装材料必须解决该布局要求。

本函数测量树内容，不认证manifest来源，也不证明所有运行时依赖均位于该树。root/native启动前的manifest认证、完整安装布局、外部动态加载路径约束和实际已安装回执仍须接线。不能仅调用这个函数就宣称完整启动信任链通过。

## Native fixed installer bootstrap

`scripts/xhs/xhs-installer-bootstrap.c` compiles as a root-invoked, non-setuid
launcher. It accepts no arguments or environment-selected paths. The independent
installer must pin/install this binary itself; this source step does not install
or authorize it. Fixed root-owned inputs under `/Library/Application Support/Flywheel/Xhs/`:

- `installer-bootstrap.policy`: exact ordered lines `version=1`,
  `manifest_sha256=<64lowerhex>`, `json_sha256=<64lowerhex>`, each LF-terminated.
- `runtime.manifest`: native projection, digest pinned above.
- `runtime.manifest.json`: original JSON inventory, separately digest pinned above.
- `runtime/node` and `runtime/installer-entry.js`: required inventory members.

Before Node execution, bootstrap checks real/effective UID0, immutable ancestry,
root:wheel single-link policy/manifest files, bounded reads and pinned hashes,
complete native tree, required entry names and executable Node mode. It rechecks
policy/manifest identities, closes fd3+, fixes stdin to `/dev/null`, cwd to `/`,
umask0077 and environment to PATH/LANG/LC_ALL; exec uses only the fixed Node and
entry paths. Any failure emits only `xhs_installer_bootstrap_unavailable`.

`renderBootstrapPolicy` derives the two byte digests; `verifyManifestProjection`
requires the exact pinned JSON/native bytes and exact projection equality. The
installed JS entry still must call this comparator using immutable reads before
provisioning. That entry and artifact assembly/signature binding are not yet
wired. Tests compile the native launcher and exercise unprivileged rejection,
policy grammar and fd cleanup; they do not run a privileged installation.

## Installed JS fixture entry and evidence storage

Install reviewed `scripts/xhs/installer-entry.mjs` bytes at the fixed
`runtime/installer-entry.js`. This small entry rejects non-root, extra arguments,
wrong Node and wrong entry paths before importing
`./packages/teamlead/dist/xiaohongshu-write/installer-main.js`; artifact assembly
must retain that module layout and all dependencies inside the verified tree.

The controller checks root/Node, immutable bootstrap policy, both manifests and
projection equality, then remeasures the JSON tree. `runtime/fixture-installer.json`
is itself an inventory-pinned strict object with schemaVersion1,
authorityConfigSha256 and modelGid. The authority policy is fixed at
`/Library/Application Support/Flywheel/Xhs/authority.json`; its exact bytes must
match that digest. Authority Node/peer/probe pins must match manifest entries;
Node must be `runtime/node`. Principal runner is fixed at
`runtime/xhs-fixture-principal` and gets its hash from the manifest.

A root-generated32-byte nonce selects the synthetic fixture. After the existing
orchestrator returns, the controller rechecks policies/manifests/tree before
persisting `fixture-evidence.json` under that nonce root using exclusive root0600
creation and file/parent fsync. Failure or policy drift produces no success
receipt and leaves previous evidence intact. stdout contains only schema,
fixture_harness classification, hostAcceptance=false, nonce, observation receipt
digest and the two signature-envelope digests.
The full file contains unsigned measurements plus config/manifest bindings; it is
not a production acceptance signature. No secret or real endpoint is passed to
synthetic probes. The signer below issues only fixture-scoped statements.
Actual installed-host acceptance remains a separate unmet prerequisite.

## Offline JavaScript runtime artifact

`node scripts/xhs/build-runtime.mjs --output-dir <new-absolute-directory>` runs
unprivileged and never installs or activates anything. It bundles the fixed
installer/authority/probe entries into the existing installed module layout using
pinned esbuild0.25.10. All JS dependencies are bundled except better-sqlite3;
only its explicit lib/native-addon files plus bindings and file-uri-to-path are
copied as ordinary files. No workspace symlink, build scripts or general package
manager runs in the artifact. The root entry and ESM package marker are included;
JSON stdout records file digests, byte sizes, bundler version and external imports.

Output is exclusively created, limited to256 files/64MiB and16MiB per file;
failed output is retained and cannot be overwritten. This is a JS-runtime fragment,
not a complete install tree: approved portable Node, C helpers, browser/provider
assets, policy/configuration and signed evidence are still required. Local test
runs exercised the copied SQLite native addon with an in-memory query and checked
all bundled entry refusals from outside the workspace. Host root acceptance was
not exercised. Native assembly must follow765b2b22; never copy the host Homebrew
Node just because the JS runtime test used it successfully as an unprivileged test
interpreter.

## Pinned offline native/JavaScript assembly

Run `node --import tsx scripts/xhs/build-native-runtime.ts --assets <absolute-input-directory> --output-dir <new-absolute-output-directory>` as an ordinary user on macOS arm64. Inputs are exactly `node`, `better_sqlite3.node`, and Node `LICENSE`, extracted from the versions documented in implementation-evidence. Source constants pin all three byte digests; there is no digest override. The command rejects root, other platforms, symlink/nonordinary inputs and incorrect hashes before creating output. It performs no downloads or installation.

The JavaScript builder accepts measured SQLite bytes directly, so native assembly never silently copies the workspace's incompatible addon. Native assembly adds the fixed Node and license, checks both generated native files with system `otool`, and runs the generated Node with clean environment and cwd at the generated tree to verify version/ABI and an actual SQLite query. Output is exclusive; failures retain partial output and cannot reuse that directory. The JSON receipt includes exact file digests and loader dependencies, `kind: offline_native_js_runtime`, and `hostAcceptance:false`.

This artifact still needs C helpers, provider/browser/media tools and configuration, complete inventory, authenticated installation and acceptance signature binding. The builder receipt itself carries no approval or installed-host authority.

## Fixed C helper assembly and pending media slots

`node scripts/xhs/build-native-helpers.mjs --output-dir <new-absolute-directory>` compiles the four root-repository C helpers and the fork's browser guardian, retaining a source/header/output digest receipt. It requires ordinary-user macOS arm64, uses fixed `/usr/bin/cc` arguments, refuses an existing output directory, and never executes helpers. The independent installer must authenticate the resulting binaries and full tree before any privileged use.

Per Lead fc07d088, browser source is official Mac_Arm Chromium revision1321438 matching fork rod0.116.2. Its internal symlinks still need materialization and complete tree measurement. **ffmpeg and ffprobe installation slots remain pending as a pair:** ffmpeg-static5.3.0 supplies a valid arm64 candidate, but ffprobe-static3.1.0's arm64-labelled file is x86_64. No architecture fallback or third distribution is authorized; question d8543257 carries the exact evidence. Source/build receipts are not host acceptance.

## Browser materialization and offline manifests

`python3 scripts/xhs/materialize-chromium.py --archive <pinned-zip> --output-dir <new-directory>` materializes only official Chromium revision1321438. Both archive and resulting tree digests are fixed in source. The five internal framework aliases become ordinary files; original paths and executable modes remain. Receipt entries include every file and nonempty directory. No browser runs.

`node --import tsx scripts/xhs/measure-runtime.ts --tree <ordinary-user-tree> --output-dir <new-directory-outside-tree>` measures bounded ordinary files and writes `runtime.manifest.json`, `runtime.manifest`, and `installer-bootstrap.policy`. These are unsigned offline inventories; the root installer must authenticate them, establish ownership, verify complete required assets/config, run mandated probes and produce signed acceptance. A partial tree can be measured but cannot thereby become installable or accepted. Current composite provenance explicitly lists missing media/config inputs.

### Media inputs resolved

Under d8543257, the same approved eugeneware/ffmpeg-static b6.1.1 release supplies an actual arm64 ffprobe. The prior ffprobe-static3.1.0 slot is superseded by this measured source, with exact URLs/digests in implementation-evidence. Native runtime assembly now additionally requires input files `ffmpeg`, `ffprobe`, `media.LICENSE`, and `media.README`; all are source-pinned and checked before output creation. It copies media binaries and license documents into the artifact and checks generated binaries' system loader paths and actual6.0 version output. Release tag b6.1.1 is recorded separately.

When composing fragments, create nested destination directories with mode0755; do not copy a fragment's private0700 staging-root mode into the runtime tree. The actual composite's browser directory was normalized before regenerating its JSON manifest. The private top-level build directory may remain0700 until the independent installer establishes its final ownership/mode.

## Shared pre-Node verification and external installation metadata

Both `xhs-installer-bootstrap` and `xhs-authority-launcher` call the same native `xhs_verify_installation` function. Before Node executes, it reads root-owned `installer-bootstrap.policy`, JSON/native runtime manifests and `installation.metadata`, verifies the complete ordinary-file runtime tree, and checks required Node/bootstrap/JS entries. A mismatch rejects startup with the offending path in a single escaped diagnostic line. Launcher Node/authority entry/config arguments now match the fixed runtime Node, bundled authority entry and `/Library/Application Support/Flywheel/Xhs/authority.json` paths.

Install `installation.metadata` outside runtime at `/Library/Application Support/Flywheel/Xhs/installation.metadata`, root:wheel0644. Its strict content is:

```
version=1
manifest_sha256=<SHA256 of native runtime.manifest bytes>
bootstrap_sha256=<SHA256 of runtime/xhs-installer-bootstrap executable bytes>
```

The inventory tool renders this file only when the executable bootstrap is present. The independent installer must authenticate this output and establish ownership before invocation. The separate `bootstrapPolicySha256` inventory measurement is not the bootstrap executable digest.

Existing signed boundary statements now require `manifestSha256` and `bootstrapSha256`. TS authority/parent and Go provider read expected values from this fixed root file. Config digests remain hashes of their configuration bytes; installation metadata is outside the tree and fixture-installer.json remains a downstream authority-config binding, preventing a manifest/config digest cycle. Installed fixture observations remeasure the binding; the root-only signer below signs fixture scope after directly collecting those probes. That signature cannot authorize production activation.

## Fixture-only signing (Lead4af8 / Lead80 A)

The fixed root bootstrap/JS entry takes no arguments or uploaded results.
Independent QA must provision an Ed25519 PKCS8 PEM at
`/Library/Application Support/Flywheel/Xhs/boundary-signing.key`: root-owned,
single-link, exact0600, at most4096 bytes, with immutable root-owned ancestors.
This file stays outside the runtime artifact. QA controls key creation and
custody; this repository and its offline builder do not provide a private key.
Only its raw32-byte base64 public key belongs in both root policy files.

The entry requires `enabled:false`. The authority receipt path must be
`/Library/Application Support/Flywheel/Xhs/acceptance.json`; provider receipt path
must be `.../provider-acceptance.json`. Both policies and all Node/helper/probe/
provider/browser/guardian/media pins must match immutable inputs and the measured
runtime tree. Provider bytes are rechecked after probes along with authority
policy, manifests and installation metadata.

After one directly collected, validated fixture run, unsigned observations are
persisted under its fresh root-reserved nonce. Only then does the installer read
the private key, compare its derived public key with both policy keys, and sign
two statements bound to the respective exact configuration digests. Both are
verified locally before publication. The temporary input-key Buffer is cleared;
this does not claim complete erasure of OpenSSL/JavaScript process memory.

The signed statement includes `probeKind:fixture_harness`, `passed:true`,
`hostAcceptance:false`, and the exact nine excluded scope names documented in
follow-ups.md. It attests file positive controls, model file denials and eight
synthetic production-module authority flows. It does not certify host isolation,
actual Claude/Codex/Runner/login contexts, process/privilege controls, private
transport, headless browser service or legacy cutover.

Publication exclusively creates root0644 receipt files and fsyncs files/parent.
No overwrite or automatic retry exists. If publication of the second receipt
fails, the first and the unsigned evidence remain; the entry reports failure.
This is not an atomic two-file commit. An authorized operator must inspect
retained files before a separately authorized fresh installation attempt.

Regardless of a valid fixture signature, production authority `enabled:true`
is refused with `host_activation_receipt_absent`. The missing independent host
activation proof protocol requires its own follow-up design. Neither root's
enabled flag nor a fixture signature can replace that prerequisite. These source
instructions are not authorization to provision accounts/keys, install, start
services or activate writes on this host.

## Offline mode consistency

Deployment requirements retain the assembled root0755 native executable modes,
root0644 Node-imported authority entry, and root0755 boundary probe bundle. The
probe is launched through Node, but both production startup pin validators also
require its execute bit. The offline bundler now emits it accordingly. Preserve
manifest modes during installation: changing0755 executables to0555 after the
manifest was measured invalidates native tree verification despite unchanged
content hashes. Root ownership and absence of group/other write remain required.

## Validated offline artifact/config assembly (Lead e73b0fbc)

Run the unprivileged builder only with public configuration inputs:

```sh
node --import tsx scripts/xhs/assemble-config.ts \
  --runtime-tree /path/to/measured-runtime-source \
  --authority-source /path/to/authority.json \
  --provider-source /path/to/provider.json \
  --qa-public-bindings /path/to/root-owned/qa-public.json \
  --output-dir /path/to/new-candidate
```

The independent QA public binding file must already have root-owned, immutable
ancestors and a root-owned single-link file. A model-owned file is rejected even
when its JSON looks valid. The builder never creates this trust input or any
private key. Its strict public schema contains exactly:

| Field | Required value |
| --- | --- |
| schemaVersion | 1 |
| targetHostId | QA's explicit target identifier, 1–256 ASCII letters/digits/dot/underscore/colon/hyphen |
| platform / architecture | darwin / arm64 |
| serviceUid / serviceGid / modelUid / modelGid / ingressGid | QA-supplied positive target numeric identities |
| acceptancePublicKey | QA-supplied raw32-byte Ed25519 public key, canonical base64 |

No defaults, privateKey, passed or hostAcceptance fields are accepted. Public
key and service/model/ingress identities must equal the policies; modelGid must
remain outside serviceGid. This checks target configuration consistency. It does
not assert those identities or the host's isolation have been tested.

Authority/provider schemas reject private credential contents and bind raw
provider bytes. Authority is disabled. Fixed entry/config/output locations and
all executable pins must be inside the runtime tree and match measured hashes
and deployment modes. Bootstrap, principal runner, installer entry and fixed
SQLite runtime files must exist. Existing fixture-installer.json is rejected;
the builder generates it from the exact authority digest and trusted modelGid.

The builder measures the source directly, copies regular single-link files with
bounded reads and before/after identity/hash checks, then measures the resulting
runtime again. No uploaded inventory is used as a passed result. Source and final
inventories are retained. QA/config inputs are rechecked before artifact.json is
written last. Failures retain partial output without this completion record;
existing output directories are never reused or overwritten.

A successful output contains runtime/, install/ (root policies, native/JSON
manifests, bootstrap policy, metadata and plist), source-inventory/,
requirements.json and artifact.json. The plist has a separate destination under
/Library/LaunchDaemons; other install/ files go under the Xhs root. These are
staging files, not an installed service. Follow requirements and measured runtime
modes during a separately authorized installation. Do not pre-create acceptance
receipts or fabricate the separately provisioned signing key from requirements.

artifact.json binds the source and final inventory, QA-input digest, target id,
and both config digests. configurationComplete:true means these artifacts were
assembled; hostAcceptance remains false. A copied artifact-provenance.json, if
present, remains the historical source-fragment provenance; its former pending
configuration slots are resolved by artifact.json and the generated config files.
This builder performs no root installation, signing, account creation, browser
launch or activation. Without external trusted QA bindings it refuses production
finalization. This runner has supplied no production keys or host identities.
