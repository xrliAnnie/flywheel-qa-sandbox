# FLY-2456 · r1 真机重启演练证据判定

本轮判定：fail。有资格体认回 0/2（0%）；B3 为非 holder 阴性对照，不计分母。

被测 HEAD：d6cda1fc13080f9c188cbfc5f354eea5a2c28f65。

B1 (8798137e-39ef-4906-8075-7b2d095a5f0e)：other。

B2 (316a116c-b44d-41ba-bdad-e8fcec8ff92f)：other。

B3 (0c1c8174-bf92-444d-b408-9da04d66311a)：other。

生产零影响（before→after 零新增；历史命中仅披露）：九组证据已逐项读取；15 项失败，2 项待归因。0 组生产终态归因如下。

comm/before：基线 108，新增 0。

comm/liveAfter：基线 108，新增 0。

comm/postTeardown：基线 108，新增 0。

prodState/before：基线 0，新增 0。

prodState/liveAfter：基线 0，新增 0。

prodState/postTeardown：基线 0，新增 0。

alerts/liveAfter：基线 3，新增 9。

alerts/postTeardown：基线 3，新增 9。



夹具与盲区：隐藏 room-info 解除 FLY-2211 排除；gate 使靶体满足 reown 资格。两轮必须使用同夹具。生产活 WAL 不作逐字相等声明；使用一致性副本污染扫描。launch-commits、归档及沙箱 PR/分支为已登记残留。

前置维护观察：UNAVAILABLE (no_unconditional_tick_observable); 墙钟 2026-09-10T16:50:49.322+00:00 → 2026-09-10T17:00:57.818000+00:00, 608496ms; Lead ruling c7791d8e-0d58-44d2-af0f-28b371382737。未声称两次 tick 已观测。

建议：先处理失败或待归因项，不据此批准 FLY-2352。

- B1: expected replaced, observed other
- B2: expected succeeded, observed other
- B3: expected skipped_not_holder, observed other
- fleet/live failed
- fleet/postTeardown failed
- proc/live failed
- live process addition not attributed to slot
- launchCommits/liveAfter failed
- launchCommits/liveAfter unbounded delta
- launchCommits/postTeardown failed
- launchCommits/postTeardown unbounded delta
- alerts/liveAfter failed
- alerts/liveAfter slot pollution
- alerts/postTeardown failed
- alerts/postTeardown slot pollution
- proc/postTeardown
- proc/teardown

证据文件及 SHA256：

- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/manifest.json: 1553f7220ea830cd7c4fc2aa61fda0035ed4ea22aeda9c923e36d51728a0bc6f
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/campaign-shape.json: 221a9d746ba5cc43744156cf048d5a4bf442568f28a907a08d5f68989c5f85c6
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/final-observe.json: 9ed6f9b29b7a303eeba1fd52f1ecac0882e43721d055122d4a0d95de75e233fe
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/zero-impact.json: e0ff573da7ba6e2573a9e143832c5f6a90b9980e468fa5f942ff065e5b68ce4e
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/fixture.json: e0b43a92031c79d8e8fdc7443cef7fd7944ed3408a3eb552a165d2dc785a303d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/comm-before.json: 13f071c2b4e0003456ce2277f006e58c9ad6b1f16318bcdc00793f49564032f9
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/prod-state-before.json: 83d28657125c506a72e2d6532555691af454ba4927c572671c6360d525ee45b7
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/fleet-live.json: 014fc44696ff2f9833789927b19fd712065a4cf11e21ae8cc1d98952c470c8ad
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/fleet-post.json: b7eae12d8a65d7f386332c7057ba11e8a58c550dcb7121efc707f90ffc393f20
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/proc-live.json: 1d31b68a095472d0675d105fde6bf9bf4f8e9fdfc67ab9994b9a3d7655d069c2
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/proc-post.json: b13415d0f04e047171c7ae35d84fc37770fcce90ccdbd705b8e9b75f488af27d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/proc-teardown.json: 667f02f33ce0d33d764e3e450f474a86ca72a77a9a78e7d0504da1673470300f
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/comm-before.json: 13f071c2b4e0003456ce2277f006e58c9ad6b1f16318bcdc00793f49564032f9
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/comm-live-after.json: 8d80bad5dfd6bbe6df405d316e8e68ee2bc0c90b75b71e21a14366bf79ae5087
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/comm-post-teardown.json: cc1a1a209d7baef6f4bb197d4973042e358947e90feef38fd3b7e230e636a10a
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/launch-live-after.json: a3b4c1caad5a4be8659d736b4d0a6db9e5b75e7102fb9f49e6beae2e4f5fc1e2
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/launch-post-teardown.json: a3b4c1caad5a4be8659d736b4d0a6db9e5b75e7102fb9f49e6beae2e4f5fc1e2
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/prod-state-before.json: 83d28657125c506a72e2d6532555691af454ba4927c572671c6360d525ee45b7
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/prod-state-live-after.json: a5fa2499199c5ae12bd1a1f19875c45f4b8b7637e95c6871d1401583f325ed3b
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/prod-state-post-teardown.json: 466f1e35266d1ef1dce2eb8f25b0706c445f4f86feb86b542ce55f6d6c4fcf1d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/alerts-live-after.json: d643ee1e263bb63445360fe2601ebd69da6ff41eb6ca458119f839dbc4321470
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/alerts-post-teardown.json: d643ee1e263bb63445360fe2601ebd69da6ff41eb6ca458119f839dbc4321470
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/windows-full.json: bb4fe5b33a0e3d3c6006eb8d134536cd4eaf21e650fc414fe47ecdf50700f895
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/windows-teardown.json: bb4fe5b33a0e3d3c6006eb8d134536cd4eaf21e650fc414fe47ecdf50700f895
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/before/health.json: 6f55d0973f0e61cf1ff65c91be95ef39bef23e9cdfbe23695ab45df06504fa84
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/live-after/health.json: a1a531d63ea0fe0d9aa868ee983914c3e6d1d27c13f8b59a70f0f442c7e1e9c3
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/pre-teardown/health.json: fcc62f38011b6cbdf8f10b33bac5d8279f15e363d8c9106983ab3538e3e03dbc
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/post-teardown/health.json: 808dcee13494444d262254f6f6446e841c20b906f3a5ca60ce801a64f1475859
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/comparisons/kill-ledger.ndjson.summary.json: 8416106298ba210f449379dfabc546055c654a34d36f384dbc7de6989b58fd56

