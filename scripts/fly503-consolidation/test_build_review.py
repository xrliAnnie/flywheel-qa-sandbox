"""
FLY-503 — tests for the consolidation review-page generator.

Focused on the security-critical + completeness invariants, because the page
renders UNTRUSTED Xiaohongshu post text (titles/summaries/authors) and is
served through the publish-report CSP pipeline (default-src 'none'; script
allowed ONLY via the __CSP_NONCE__ placeholder + nonce). The page therefore
MUST: HTML-escape every untrusted string, opt into scripts via the nonce
placeholder, carry NO inline event handlers (a script nonce does not cover
onclick=), embed every issue exactly once, and stay a complete <head>-bearing
document under the 512KB publish-report cap.
"""

import json
import re

import build_review as br

MAX_HTML_SIZE = 512 * 1024


def _sample():
    issues = [
        {
            "id": "FLY-1",
            "title": "safe title",
            "author": "Kai",
            "sourceUrl": "https://www.xiaohongshu.com/explore/abc",
            "summary": "a summary",
            "linearUrl": "https://linear.app/studio/issue/FLY-1",
        },
        {
            "id": "FLY-2",
            "title": "<script>alert(1)</script> & \"quote\" 'apos'",
            "author": "<b>x</b>",
            "sourceUrl": "javascript:alert(1)",
            "summary": "evil <img src=x onerror=alert(1)>",
            "linearUrl": "https://linear.app/studio/issue/FLY-2",
        },
        {
            "id": "FLY-3",
            "title": "rep",
            "author": "y",
            "sourceUrl": "https://www.xiaohongshu.com/explore/def",
            "summary": "s3",
            "linearUrl": "https://linear.app/studio/issue/FLY-3",
        },
        {
            "id": "FLY-4",
            "title": "hw",
            "author": "z",
            "sourceUrl": "https://www.xiaohongshu.com/explore/ghi",
            "summary": "s4",
            "linearUrl": "https://linear.app/studio/issue/FLY-4",
        },
    ]
    clusters = {
        "clusters": [
            {
                "key": "c1",
                "title": "Cluster One",
                "crossProject": False,
                "blurb": "blurb one",
                "items": [
                    {"id": "FLY-3", "role": "representative", "rationale": "rep r"},
                    {
                        "id": "FLY-1",
                        "role": "merge",
                        "into": "FLY-3",
                        "confidence": "high",
                        "rationale": "merge r",
                    },
                    {"id": "FLY-2", "role": "independent", "rationale": "indep r"},
                ],
            },
            {
                "key": "c2",
                "title": "Hardware",
                "crossProject": True,
                "blurb": "blurb two",
                "items": [
                    {
                        "id": "FLY-4",
                        "role": "route_out",
                        "target": "Joycon",
                        "rationale": "route r",
                    },
                ],
            },
        ]
    }
    return issues, clusters


def test_escape_html_escapes_five_chars():
    assert br.escape_html("<a> & \"b\" 'c'") == "&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;"


def test_safe_url_allows_xiaohongshu_https_only():
    assert br.safe_url("https://www.xiaohongshu.com/explore/x", br.NOTE_HOSTS) == (
        "https://www.xiaohongshu.com/explore/x"
    )
    assert br.safe_url("http://www.xiaohongshu.com/x", br.NOTE_HOSTS) is None
    assert br.safe_url("javascript:alert(1)", br.NOTE_HOSTS) is None
    assert br.safe_url("https://evil.com/x", br.NOTE_HOSTS) is None
    assert br.safe_url("not a url", br.NOTE_HOSTS) is None
    # Subdomain of an allowed host is OK; a host that merely ends with the
    # allowed string but isn't a subdomain is NOT.
    assert br.safe_url("https://sub.xiaohongshu.com/x", br.NOTE_HOSTS) is not None
    assert br.safe_url("https://notxiaohongshu.com/x", br.NOTE_HOSTS) is None
    assert br.safe_url("https://xiaohongshu.com.evil.com/x", br.NOTE_HOSTS) is None


def test_safe_url_rejects_parser_differential_bypass():
    # Backslash authority: browser (WHATWG) treats "\" as "/", so this navigates
    # to evil.com even though Python urlparse reports host xiaohongshu.com.
    assert br.safe_url("https://evil.com\\@xiaohongshu.com/x", br.NOTE_HOSTS) is None
    # Userinfo form of the same trick — host is allowlisted but userinfo is the
    # misleading part; reject outright.
    assert br.safe_url("https://evil.com@xiaohongshu.com/x", br.NOTE_HOSTS) is None
    assert br.safe_url("https://user:pass@xiaohongshu.com/x", br.NOTE_HOSTS) is None
    # Control char (e.g. embedded CR/tab) — browsers strip these; reject.
    assert br.safe_url("https://xiaohongshu.com\r/evil", br.NOTE_HOSTS) is None
    assert br.safe_url("https://xiaohongshu.com\t.evil.com/x", br.NOTE_HOSTS) is None


def test_doc_is_complete_with_head():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    assert html.lstrip().lower().startswith("<!doctype html>")
    assert "<head" in html.lower()
    assert "</html>" in html.lower()


def test_script_uses_csp_nonce_placeholder():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    # Opt into scripts the way the publish-report pipeline expects.
    assert '<script nonce="__CSP_NONCE__">' in html


def test_no_inline_event_handlers():
    # Use CLEAN issue text so the only on*= a substring search could find would
    # come from the generator's OWN markup (which must use addEventListener).
    issues = [
        {
            "id": "FLY-1",
            "title": "clean",
            "author": "a",
            "sourceUrl": "https://www.xiaohongshu.com/explore/x",
            "summary": "clean summary",
            "linearUrl": "https://linear.app/studio/issue/FLY-1",
        }
    ]
    clusters = {
        "clusters": [
            {
                "key": "c",
                "title": "C",
                "crossProject": False,
                "blurb": "b",
                "items": [{"id": "FLY-1", "role": "independent", "rationale": "r"}],
            }
        ]
    }
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    # A script nonce does NOT cover inline handlers — they would be blocked.
    for handler in ("onclick=", "onchange=", "oninput=", "onload=", "onerror="):
        assert handler not in html.lower(), f"inline handler {handler} must not appear"


def test_every_issue_present_exactly_once():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    for it in issues:
        # Each issue gets one card keyed by a data attribute.
        assert html.count(f'data-issue="{it["id"]}"') == 1


def test_untrusted_content_is_escaped():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    # The raw malicious markup must never appear as a REAL tag (the `<` is escaped).
    assert "<script>alert(1)</script>" not in html
    assert "<img src=x" not in html
    # The escaped forms should be present (inert text — onerror=… as literal text
    # inside &lt;img …&gt; is harmless; what matters is the `<`/`>` are escaped).
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "&lt;img src=x onerror=alert(1)&gt;" in html


def test_javascript_source_url_rendered_inert():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    # FLY-2 has a javascript: sourceUrl — it must NOT become an href.
    assert 'href="javascript:' not in html


def test_decision_defaults_match_role():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    # Merge item FLY-1 → its "merge" radio is checked by default.
    merge_block = re.search(
        r'data-issue="FLY-1".*?(?=data-issue="|</body>)', html, re.S
    ).group(0)
    assert re.search(r'value="merge"[^>]*\bchecked\b', merge_block) or re.search(
        r'\bchecked\b[^>]*value="merge"', merge_block
    )
    # Route-out item FLY-4 → its "route_out" radio is checked by default.
    route_block = re.search(
        r'data-issue="FLY-4".*?(?=data-issue="|</body>)', html, re.S
    ).group(0)
    assert "route_out" in route_block and "checked" in route_block


def test_export_button_and_output_present():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    assert 'id="copy-json"' in html
    assert 'id="export-output"' in html


def test_cluster_titles_and_crossproject_rendered():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    assert "Cluster One" in html
    assert "Hardware" in html
    # cross-project cluster gets a visible flag
    assert "跨项目" in html


def test_size_under_publish_cap():
    issues, clusters = _sample()
    html = br.build_html(issues, clusters, generated_at="2026-06-22")
    assert len(html.encode("utf-8")) < MAX_HTML_SIZE
