#!/usr/bin/env python3
"""Render review-log.html (founder page section) from the Codex design-review feedback
files. Input: one or more markdown feedback files (round order = argument order).
Every piece of reviewer-derived text is HTML-escaped before interpolation."""
import html
import pathlib
import re
import sys

here = pathlib.Path(__file__).resolve().parent
files = [pathlib.Path(p) for p in sys.argv[1:]]
if not files:
    sys.exit("usage: build-review-log.py <round1.md> [<round2.md> ...]")

rows = []
final_status = None
for n, path in enumerate(files, start=1):
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^Status:\s*(APPROVED|CHANGES REQUESTED)", text, re.M)
    status = m.group(1) if m else "UNKNOWN"
    final_status = status
    issues = re.findall(r"^\d+\.\s+\*\*\[(BLOCKER|HIGH|MEDIUM|LOW)\]\s*(.+?)\*\*", text, re.M)
    counts = {}
    for sev, _ in issues:
        counts[sev] = counts.get(sev, 0) + 1
    count_txt = " / ".join(f"{k} {v}" for k, v in counts.items()) if counts else "0 条"
    titles = "".join(
        f"<li><span class=\"badge {'no' if sev == 'BLOCKER' else 'maybe' if sev == 'HIGH' else 'q'}\">{html.escape(sev)}</span>{html.escape(title.strip())}</li>"
        for sev, title in issues
    )
    badge = "do" if status == "APPROVED" else "no"
    rows.append(
        f"<h3>第 {n} 轮 · <span class=\"badge {badge}\">{html.escape(status)}</span> <span class=\"note\">{html.escape(count_txt)}</span></h3>"
        + (f"<ul>{titles}</ul>" if titles else "<p class=\"note\">无遗留意见。</p>")
    )

summary = (
    f"<p class=\"note\">独立设计评审(Codex,xhigh)共 {len(files)} 轮;每轮的意见都逐条对照代码核实后再采纳,"
    f"改动记录在 plan §10。最终判定:<b>{html.escape(final_status or 'UNKNOWN')}</b>。评审记录只落在评审文件与编排收据里,不写进被评审的 plan 本身。</p>"
)
out = summary + "".join(rows)
(here / "review-log.html").write_text(out, encoding="utf-8")
print(f"wrote review-log.html ({len(out)} bytes), rounds={len(files)}, final={final_status}")
