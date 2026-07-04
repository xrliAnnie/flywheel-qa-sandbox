#!/usr/bin/env python3
"""
FLY-503 — generate the interactive [XHS-deep] consolidation review page.

Reads two committed data files in this directory:
  - issues.json   : the 49 [XHS-deep] Backlog issues (id/title/author/source/summary)
  - clusters.json : the consolidation PROPOSAL (cluster grouping + per-issue role +
                    default decision + rationale)

and emits a single self-contained HTML page for the founder to review and decide
on. The page is delivered via `flywheel-comm publish-report`, which serves it
under a strict CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src
data:;`) and only allows scripts that opt in via the literal `__CSP_NONCE__`
placeholder (the pipeline mints a real per-report nonce and rewrites
`script-src 'nonce-…'`).

Security model (mirrors packages/teamlead/src/bridge/xhs-review-html.ts):
  * EVERY founder-/post-derived string is HTML-escaped before it enters the page.
  * Source/Linear URLs become <a href> ONLY after a scheme(https)+host allowlist
    check; anything else renders as inert escaped text.
  * The interactive logic lives in ONE `<script nonce="__CSP_NONCE__">` and binds
    every handler via addEventListener (a script nonce does NOT cover inline
    onclick=). NO untrusted data is embedded into the script — it reads decisions
    from the DOM, so an injected `</script>` in post text cannot break out.

Propose-first: this page only PROPOSES. No Linear mutation happens here. The
founder toggles per-issue decisions, copies the exported decision JSON, and a
Phase-2 step executes the merges from that JSON.
"""

from __future__ import annotations

import json
import sys
from datetime import date, timezone, datetime
from pathlib import Path
from urllib.parse import urlparse

NOTE_HOSTS = ["xiaohongshu.com", "xhslink.com", "rednote.com"]
LINEAR_HOSTS = ["linear.app"]

# Decision option sets per role: (value, label, is_default).
ROLE_OPTIONS = {
    "representative": [
        ("keep", "代表 · 保留", True),
        ("cancel", "取消", False),
    ],
    "merge": [
        ("merge", "合并入代表", True),
        ("keep", "保持独立", False),
        ("cancel", "取消", False),
    ],
    "independent": [
        ("keep", "保留独立", True),
        ("merge", "合并(在评论注明目标)", False),
        ("cancel", "取消", False),
    ],
    "route_out": [
        ("route_out", "路由出 Flywheel", True),
        ("keep", "保留在 Flywheel", False),
        ("cancel", "取消", False),
    ],
}

ROLE_BADGE = {
    "representative": ("代表", "rep"),
    "merge": ("建议合并", "merge"),
    "independent": ("独立", "indep"),
    "route_out": ("跨项目", "route"),
}


def escape_html(s: object) -> str:
    """Escape the 5 dangerous chars for text + double-quoted attribute context."""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _host_allowed(host: str, allowed: list[str]) -> bool:
    h = host.lower()
    return any(h == d or h.endswith("." + d) for d in allowed)


def safe_url(url: object, allowed_hosts: list[str]) -> str | None:
    """Return a safe https URL whose host is allowlisted, else None.

    Hardened against a parser-differential host-allowlist bypass: a browser
    (WHATWG) treats a backslash in the authority as a `/` and userinfo (`u@h`)
    as separate from the host, so `https://evil.com\\@xiaohongshu.com/x` would
    navigate to evil.com even though Python's `urlparse().hostname` reports the
    allowlisted `xiaohongshu.com`. Reject backslashes, control chars, and any
    userinfo before trusting the parsed host.
    """
    if not isinstance(url, str):
        return None
    # WHATWG treats "\\" as "/" in the authority; Python urlparse does not.
    # Control chars are likewise stripped/handled differently by browsers.
    if "\\" in url or any(ord(c) < 0x20 or ord(c) == 0x7f for c in url):
        return None
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme != "https" or not u.hostname:
        return None
    # Reject userinfo — the "evil@allowed-host" form is the other half of the
    # parser-differential trick; legitimate source/Linear URLs never carry it.
    if u.username or u.password:
        return None
    if not _host_allowed(u.hostname, allowed_hosts):
        return None
    return url


def _link_or_inert(url: object, allowed_hosts: list[str], label: str) -> str:
    safe = safe_url(url, allowed_hosts)
    if safe:
        return (
            f'<a href="{escape_html(safe)}" rel="noopener noreferrer" '
            f'target="_blank">{escape_html(label)}</a>'
        )
    return f'<span class="inert">{escape_html(label)} (链接不可用)</span>'


def _render_decision(issue_id: str, role: str, into: str | None) -> str:
    options = ROLE_OPTIONS.get(role, ROLE_OPTIONS["independent"])
    name = f"decision-{escape_html(issue_id)}"
    radios = []
    for value, label, is_default in options:
        if value == "merge" and into and role == "merge":
            label = f"合并入 {into}"
        checked = " checked" if is_default else ""
        radios.append(
            f'<label class="opt"><input type="radio" name="{name}" '
            f'value="{escape_html(value)}"{checked}> {escape_html(label)}</label>'
        )
    return '<div class="decision">' + " ".join(radios) + "</div>"


def _render_card(item: dict, issue: dict, cluster_key: str) -> str:
    issue_id = item["id"]
    role = item.get("role", "independent")
    into = item.get("into")
    target = item.get("target")
    badge_label, badge_cls = ROLE_BADGE.get(role, ("?", "indep"))

    title = escape_html(issue.get("title") or "(无标题)")
    author = escape_html(issue.get("author") or "")
    summary = escape_html(issue.get("summary") or "")
    rationale = escape_html(item.get("rationale") or "")
    confidence = item.get("confidence")

    src_link = _link_or_inert(issue.get("sourceUrl"), NOTE_HOSTS, "原帖")
    linear_link = _link_or_inert(issue.get("linearUrl"), LINEAR_HOSTS, escape_html(issue_id))

    proposal_bits = []
    if role == "merge" and into:
        conf = f" · 置信 {escape_html(confidence)}" if confidence else ""
        proposal_bits.append(f"建议合并入 <strong>{escape_html(into)}</strong>{conf}")
    elif role == "representative":
        proposal_bits.append("建议作本组<strong>代表</strong>(合并目标)")
    elif role == "route_out":
        proposal_bits.append(
            f"建议路由到 <strong>{escape_html(target or '其它项目')}</strong> · "
            "不并入 Flywheel"
        )
    else:
        proposal_bits.append("建议<strong>独立保留</strong>")
    proposal = " · ".join(proposal_bits)

    data_attrs = (
        f'data-issue="{escape_html(issue_id)}" '
        f'data-cluster="{escape_html(cluster_key)}" '
        f'data-role="{escape_html(role)}"'
    )
    if into:
        data_attrs += f' data-into="{escape_html(into)}"'
    if target:
        data_attrs += f' data-target="{escape_html(target)}"'

    return f"""<article class="card {badge_cls}" {data_attrs}>
  <div class="card-head">
    <span class="issue-id">{linear_link}</span>
    <span class="badge {badge_cls}">{escape_html(badge_label)}</span>
    {f'<span class="author">@{author}</span>' if author else ''}
    <span class="src">{src_link}</span>
  </div>
  <div class="card-title">{title}</div>
  <div class="summary">{summary}</div>
  <div class="proposal">{proposal}</div>
  <div class="rationale">理由：{rationale}</div>
  {_render_decision(issue_id, role, into)}
  <label class="comment-label">评论(可选)：
    <textarea name="comment-{escape_html(issue_id)}" rows="2" maxlength="2000"></textarea>
  </label>
</article>"""


def _render_cluster(cluster: dict, issues_by_id: dict) -> str:
    key = cluster.get("key", "")
    title = escape_html(cluster.get("title") or "")
    blurb = escape_html(cluster.get("blurb") or "")
    cross = bool(cluster.get("crossProject"))
    items = cluster.get("items", [])
    cards = "\n".join(
        _render_card(it, issues_by_id.get(it["id"], {"id": it["id"]}), key)
        for it in items
    )
    cross_badge = (
        '<span class="xproj-badge">跨项目 · 默认不并入</span>' if cross else ""
    )
    section_cls = "cluster xproj" if cross else "cluster"
    return f"""<section class="{section_cls}">
  <div class="cluster-head">
    <h2>{title} <span class="count">{len(items)}</span></h2>
    {cross_badge}
  </div>
  <p class="blurb">{blurb}</p>
  {cards}
</section>"""


def build_html(issues: list[dict], clusters: dict, generated_at: str) -> str:
    issues_by_id = {o["id"]: o for o in issues}
    cluster_list = clusters.get("clusters", [])
    total = sum(len(c.get("items", [])) for c in cluster_list)
    n_merge = sum(
        1 for c in cluster_list for it in c["items"] if it.get("role") == "merge"
    )
    n_rep = sum(
        1 for c in cluster_list for it in c["items"] if it.get("role") == "representative"
    )
    n_indep = sum(
        1 for c in cluster_list for it in c["items"] if it.get("role") == "independent"
    )
    n_route = sum(
        1 for c in cluster_list for it in c["items"] if it.get("role") == "route_out"
    )

    sections = "\n".join(_render_cluster(c, issues_by_id) for c in cluster_list)
    gen_js = json.dumps(generated_at)  # safe JS literal (controlled value)

    return f"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-503 — [XHS-deep] backlog 合并 review</title>
<style>
  :root {{ --ink:#1d1d1f; --dim:#86868b; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, system-ui, "PingFang SC", sans-serif;
    background:#f5f5f7; color:var(--ink); max-width:960px; margin:0 auto;
    padding:1.5rem 1rem 6rem; line-height:1.5; }}
  h1 {{ font-size:1.5rem; margin:.2rem 0; }}
  .intro {{ color:#333; font-size:.95rem; background:#fff; border-radius:12px;
    padding:1rem 1.25rem; box-shadow:0 1px 3px rgba(0,0,0,.06); margin:1rem 0; }}
  .intro b {{ color:#1a365d; }}
  .cluster {{ margin:1.75rem 0; }}
  .cluster-head {{ display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }}
  .cluster-head h2 {{ font-size:1.2rem; margin:.4rem 0; }}
  .count {{ color:var(--dim); font-size:.9rem; font-weight:400; }}
  .xproj-badge {{ background:#fbeae9; color:#ff3b30; font-size:.78rem;
    padding:.15rem .55rem; border-radius:999px; }}
  .blurb {{ color:#555; font-size:.9rem; margin:.2rem 0 .8rem; }}
  .card {{ background:#fff; border-radius:12px; padding:.9rem 1.1rem; margin:.7rem 0;
    box-shadow:0 1px 3px rgba(0,0,0,.06); border-left:4px solid #d2d2d7; }}
  .card.rep {{ border-left-color:#007aff; }}
  .card.merge {{ border-left-color:#ff9500; }}
  .card.indep {{ border-left-color:#34c759; }}
  .card.route {{ border-left-color:#af52de; }}
  .card-head {{ display:flex; align-items:center; gap:.55rem; flex-wrap:wrap;
    font-size:.85rem; }}
  .issue-id a {{ font-family:"SF Mono", ui-monospace, monospace; color:#1a365d;
    font-weight:600; text-decoration:none; }}
  .badge {{ font-size:.74rem; padding:.1rem .5rem; border-radius:999px;
    color:#fff; }}
  .badge.rep {{ background:#007aff; }}
  .badge.merge {{ background:#ff9500; }}
  .badge.indep {{ background:#34c759; }}
  .badge.route {{ background:#af52de; }}
  .author {{ color:var(--dim); }}
  .src a {{ color:#007aff; text-decoration:none; }}
  .inert {{ color:#bbb; }}
  .card-title {{ font-weight:600; margin:.35rem 0 .25rem; }}
  .summary {{ color:#333; font-size:.9rem; }}
  .proposal {{ color:#1a365d; font-size:.85rem; margin:.45rem 0 .2rem; }}
  .rationale {{ color:#666; font-size:.82rem; margin-bottom:.5rem; }}
  .decision {{ display:flex; gap:.4rem; flex-wrap:wrap; margin:.3rem 0; }}
  .opt {{ font-size:.84rem; background:#f5f5f7; border:1px solid #e0e0e5;
    border-radius:8px; padding:.25rem .55rem; cursor:pointer; }}
  .comment-label {{ display:block; font-size:.82rem; color:#555; margin-top:.4rem; }}
  textarea {{ width:100%; font-family:inherit; font-size:.85rem; border:1px solid #e0e0e5;
    border-radius:8px; padding:.4rem; margin-top:.2rem; }}
  .exportbar {{ position:sticky; top:0; z-index:5; background:rgba(245,245,247,.95);
    backdrop-filter:saturate(180%) blur(8px); padding:.6rem 0; margin-bottom:.5rem;
    border-bottom:1px solid #e0e0e5; }}
  .exportbar .row {{ display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; }}
  button {{ font:inherit; font-size:.9rem; background:#007aff; color:#fff; border:0;
    border-radius:8px; padding:.45rem .9rem; cursor:pointer; }}
  button.secondary {{ background:#e8e8ed; color:#1d1d1f; }}
  .tally {{ font-size:.85rem; color:#444; }}
  .tally span {{ font-weight:600; }}
  #export-output {{ white-space:pre-wrap; word-break:break-all; background:#1d1d1f;
    color:#e8e8ed; font-family:"SF Mono", ui-monospace, monospace; font-size:.78rem;
    border-radius:10px; padding:.8rem; margin-top:.6rem; max-height:340px;
    overflow:auto; display:none; }}
  #copy-status {{ font-size:.85rem; color:#34c759; }}
</style>
</head>
<body>
<h1>FLY-503 — [XHS-deep] backlog 合并 review</h1>
<div class="exportbar">
  <div class="row">
    <button id="copy-json" type="button">复制决策 JSON</button>
    <button id="toggle-output" type="button" class="secondary">查看/隐藏 JSON</button>
    <span class="tally">合并 <span id="t-merge">0</span> · 保留 <span id="t-keep">0</span>
      · 路由 <span id="t-route">0</span> · 取消 <span id="t-cancel">0</span></span>
    <span id="copy-status"></span>
  </div>
  <pre id="export-output"></pre>
</div>
<div class="intro">
  <p>这是 FLY-349 v2 deep-scan 留下的 <b>{total} 条 [XHS-deep] Backlog issue</b>
  的合并提案。每条都给了一个默认建议(代表 / 合并 / 独立 / 跨项目路由)，你逐条调整即可。</p>
  <p>提案默认：<b>{n_rep} 代表</b> · <b>{n_merge} 合并</b> · <b>{n_indep} 独立</b> ·
  <b>{n_route} 跨项目路由</b>。全采纳合并则 {total} → {total - n_merge}。</p>
  <p>用法：逐条选 <b>合并 / 保持独立 / 路由 / 取消</b>，需要的话写评论(尤其想合并到别的目标时注明)。
  改完点 <b>复制决策 JSON</b>，把它发回给 Tadashi，我据此执行 Phase 2(合并入代表 + 被合并标
  duplicateOf + Canceled，全程保留各来源 provenance)。<b>在你导出之前不会动任何 Linear issue。</b></p>
</div>
{sections}
<script nonce="__CSP_NONCE__">
(function () {{
  "use strict";
  var GENERATED_AT = {gen_js};
  function collect() {{
    var cards = document.querySelectorAll("article.card[data-issue]");
    var out = [];
    cards.forEach(function (el) {{
      var id = el.getAttribute("data-issue");
      var checked = el.querySelector('input[type=radio]:checked');
      var decision = checked ? checked.value : null;
      var ta = el.querySelector("textarea");
      out.push({{
        id: id,
        cluster: el.getAttribute("data-cluster"),
        role: el.getAttribute("data-role"),
        decision: decision,
        target: el.getAttribute("data-into") || el.getAttribute("data-target") || null,
        comment: ta ? ta.value.trim() : ""
      }});
    }});
    return out;
  }}
  function tally() {{
    var rows = collect();
    var c = {{ merge: 0, keep: 0, route_out: 0, cancel: 0 }};
    rows.forEach(function (r) {{ if (r.decision in c) c[r.decision]++; }});
    document.getElementById("t-merge").textContent = c.merge;
    document.getElementById("t-keep").textContent = c.keep;
    document.getElementById("t-route").textContent = c.route_out;
    document.getElementById("t-cancel").textContent = c.cancel;
  }}
  function payload() {{
    return JSON.stringify(
      {{ issue: "FLY-503", generatedAt: GENERATED_AT, decisions: collect() }},
      null, 2
    );
  }}
  document.addEventListener("change", function (e) {{
    if (e.target && e.target.type === "radio") tally();
  }});
  document.getElementById("copy-json").addEventListener("click", function () {{
    var json = payload();
    var out = document.getElementById("export-output");
    out.textContent = json;
    out.style.display = "block";
    var status = document.getElementById("copy-status");
    function ok() {{ status.textContent = "已复制 ✓"; }}
    function fail() {{ status.textContent = "复制失败，请手动选择下面文本"; }}
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(json).then(ok, fail);
    }} else {{
      fail();
    }}
  }});
  document.getElementById("toggle-output").addEventListener("click", function () {{
    var out = document.getElementById("export-output");
    if (out.style.display === "block") {{ out.style.display = "none"; }}
    else {{ out.textContent = payload(); out.style.display = "block"; }}
  }});
  tally();
}})();
</script>
</body>
</html>"""


def main(argv: list[str]) -> int:
    here = Path(__file__).resolve().parent
    issues = json.loads((here / "issues.json").read_text(encoding="utf-8"))
    clusters = json.loads((here / "clusters.json").read_text(encoding="utf-8"))
    out_path = Path(argv[1]) if len(argv) > 1 else here / "FLY-503-consolidation-review.html"
    generated_at = datetime.now(timezone.utc).date().isoformat()
    html = build_html(issues, clusters, generated_at)
    out_path.write_text(html, encoding="utf-8")
    size = len(html.encode("utf-8"))
    print(f"wrote {out_path} ({size} bytes, {len(issues)} issues)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
