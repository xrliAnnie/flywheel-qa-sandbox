# FLY-2546 SIGTERM 测试同步 — 调研
Issue: FLY-2546 (https://linear.app/geoforge3d/issue/FLY-2546/flake-flywheel-log-janitortestsh-sigterm-契约在-ci-shell2-间歇红sent1)
日期: 2026-09-14
基于: exploration.md

## 代码证据
scripts/flywheel-log-janitor.sh main 在 acquire_lock 成功之后安装 EXIT/INT/TERM trap；run_codex_artifacts 收集候选后经 probe_open_candidates 调用已有 LSOF_BIN。测试 run_janitor 已支持 JANITOR_TEST_LSOF_BIN，并使用 env -i 隔离宿主。
选择在该测试专用 lsof 可执行夹具中发布 ready 文件，随后有限等待 release 文件。此时主 Bash 正等待命令替换；发送 TERM 后放行夹具，Bash 返回时执行挂起的 TERM trap。一个过期候选足以进入该路径，无需用 600 文件或固定延时制造机会。
诊断先运行未改测试，必要时用临时提取的同一用例重现延迟发送调度；不得把缺依赖失败当作目标红。所有临时实验记录准确说明差异。
