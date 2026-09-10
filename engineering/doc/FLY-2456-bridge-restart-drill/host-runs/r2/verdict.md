# FLY-2456 · r2 真机重启演练证据判定

本轮判定：fail。有资格体认回 0/2（0%）；B3 为非 holder 阴性对照，不计分母。

被测 HEAD：85d516e6c42404326aad0f081489b457a33146f7。

B1 (3835df15-3676-4717-a094-00b63bfde129)：other。

B2 (8914c4c2-ff29-464c-9efb-3b61b945e5b5)：other。

B3 (4176c67b-ee4b-485c-a93e-761a7c57a60d)：skipped_not_holder。

生产零影响（before→after 零新增；历史命中仅披露）：九组证据已逐项读取；12 项失败，2 项待归因。0 组生产终态归因如下。

comm/before：基线 327，新增 0。

comm/liveAfter：基线 327，新增 0。

comm/postTeardown：基线 327，新增 0。

prodState/before：基线 0，新增 0。

prodState/liveAfter：基线 0，新增 0。

prodState/postTeardown：基线 0，新增 0。

alerts/liveAfter：基线 43，新增 13。

alerts/postTeardown：基线 43，新增 13。



夹具与盲区：隐藏 room-info 解除 FLY-2211 排除；gate 使靶体满足 reown 资格。两轮必须使用同夹具。生产活 WAL 不作逐字相等声明；使用一致性副本污染扫描。launch-commits、归档及沙箱 PR/分支为已登记残留。

前置维护观察：UNAVAILABLE (no_unconditional_tick_observable); 墙钟 2026-09-10T16:50:49.322+00:00 → 2026-09-10T17:00:57.818000+00:00, 608496ms; Lead ruling c7791d8e-0d58-44d2-af0f-28b371382737。未声称两次 tick 已观测。

建议：先处理失败或待归因项，不据此批准 FLY-2352。

- B1: expected succeeded, observed other
- B2: expected succeeded, observed other
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

- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/manifest.json: 5046ad5e80aef093c31809063b77ce7975c28f673ef2c250fff15976d9b3581e
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/campaign-shape.json: 0f4cb5b5f1d54149722a45275e8cc70769b36d5c95ba2a651dc848d87824efc7
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/final-observe.json: d09356f92ac8a48115954f64cf4e310d3edf38f8e9dc8379b886067c104bd23e
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/zero-impact.json: db544d74bad7a7d55905ca9d6c891041a85fdd35689b2fd96df4e80624797186
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/fixture.json: 0e12ac86e1486dbf2fda3945458e708e68266ce000458e1f3733e3f9349cf3be
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/comm-before.json: 6a0285d0be71c5e3f5a7d283912ed1ccfce0d7807354c4da1e1fecc939976b49
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/prod-state-before.json: f1bcb809621f975ef62dfe6f12ca3725b56111a3b2f1c4787ba274ea22c6c041
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/fleet-live.json: 9a611e22b5e08b6a509c3f129537173af65bc70674ab7793604e01e275e64d2d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/fleet-post.json: 9a611e22b5e08b6a509c3f129537173af65bc70674ab7793604e01e275e64d2d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/proc-live.json: d17b72028cba913e22f9d2ba0c3676cedc9a8607f93434a318f81ef45417397d
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/proc-post.json: 3ca9e4848a1ecfe223df634a5c285504fbb748fa057b26545e63267f9b593c73
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/proc-teardown.json: bb78a45925f34b6fdb64cbfa80387bd1eda8d6d450d744b4a22a8806280aea01
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/comm-before.json: 6a0285d0be71c5e3f5a7d283912ed1ccfce0d7807354c4da1e1fecc939976b49
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/comm-live-after.json: 9b885f5d15b096363c1ad0d8d225002e00770273a896ee692e7507fc4d095688
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/comm-post-teardown.json: 2197994c84381821e0fae66da272dea4926c23a6751486fc4dda15732a49c496
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/launch-live-after.json: 872593cc62dd6754a7f3b2ffafa6f8390260804e772d97913152d8ea182c5f9f
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/launch-post-teardown.json: 872593cc62dd6754a7f3b2ffafa6f8390260804e772d97913152d8ea182c5f9f
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/prod-state-before.json: f1bcb809621f975ef62dfe6f12ca3725b56111a3b2f1c4787ba274ea22c6c041
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/prod-state-live-after.json: 5efffa774299d784c59af1917d1c300e720419d96dbfd9115f050da7ec4c9bb0
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/prod-state-post-teardown.json: 29abdb3dfb35a84e082bb13d92f2ce9c194b5bf9a8b3f5877f5329b51f25e5fd
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/alerts-live-after.json: ddc85da55765c2404820c18969ad293e7b0be21be864a29142a73034cd61d26e
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/alerts-post-teardown.json: ddc85da55765c2404820c18969ad293e7b0be21be864a29142a73034cd61d26e
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/windows-full.json: bb4fe5b33a0e3d3c6006eb8d134536cd4eaf21e650fc414fe47ecdf50700f895
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/windows-teardown.json: bb4fe5b33a0e3d3c6006eb8d134536cd4eaf21e650fc414fe47ecdf50700f895
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/before/health.json: bc76f31304407f094497b76a04199cad1ad85eb36629e102789712d7a589c370
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/live-after/health.json: 9421ece2f7012f311167c4b4bfdadd1c0e486ee85f5d875c7a777e499e26fc9a
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/pre-teardown/health.json: efe14dcfeb52af84f808cd52c9de4aa6be6aafdadf9bca07ebd6ab8dc9689390
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/post-teardown/health.json: f1477e30e989be2f5b96f3dddbd0ef4a4b0f6bfd2cecc5fdb210668f83f9b66a
- /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/comparisons/kill-ledger.ndjson.summary.json: 792479dcfe60fc2bc26ed8eaae18850ff8c566ece80acfd0a382d03b12a28db3

