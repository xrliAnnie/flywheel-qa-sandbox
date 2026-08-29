"""FLY-349: tests for the review-page markdown→HTML renderer (_md_to_html).

The card bodies are AI analysis of UNTRUSTED third-party XHS content, so the
renderer MUST (a) render a small markdown subset (bold/italic/code/bullets/
paragraphs) so Annie sees clean HTML — not literal * / ** / - markers — and
(b) escape all HTML first so the untrusted content can never inject markup.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import run  # noqa: E402


def test_bold():
    h = run._md_to_html("**bold**")
    assert "<strong>bold</strong>" in h
    assert "**" not in h  # no raw bold markers leak


def test_bullets():
    h = run._md_to_html("- a\n- b")
    assert "<ul>" in h and "<li>a</li>" in h and "<li>b</li>" in h
    assert "\n- " not in h and not h.lstrip().startswith("- ")


def test_star_bullets():
    h = run._md_to_html("* a\n* b")
    assert "<li>a</li>" in h and "<li>b</li>" in h


def test_inline_code():
    h = run._md_to_html("use `Orchestrator` here")
    assert "<code>Orchestrator</code>" in h
    assert "`" not in h


def test_paragraph():
    h = run._md_to_html("hello world")
    assert "<p>hello world</p>" in h


def test_bullet_bold_label():
    h = run._md_to_html("- **采纳架构蓝图**: 借鉴")
    assert "<li><strong>采纳架构蓝图</strong>: 借鉴</li>" in h


def test_xss_escaped():
    h = run._md_to_html("<script>alert(1)</script>")
    assert "<script>" not in h
    assert "&lt;script&gt;" in h


def test_xss_in_bold():
    h = run._md_to_html("**<img src=x onerror=alert(1)>**")
    assert "<img" not in h
    assert "&lt;img" in h
    assert "<strong>" in h


def test_empty():
    assert run._md_to_html("") == ""
    assert run._md_to_html(None) == ""


def test_mixed_para_then_bullets():
    h = run._md_to_html("Intro para.\n\n- one\n- two")
    assert "<p>Intro para.</p>" in h
    assert "<ul>" in h and "<li>one</li>" in h and "<li>two</li>" in h


def test_real_keypoints_block():
    src = (
        "- **采纳架构蓝图**: 借鉴 `Orchestrator` 模块。\n"
        "- **建立中心化调度**: 唯一真理之源。"
    )
    h = run._md_to_html(src)
    assert h.count("<li>") == 2
    assert "<strong>采纳架构蓝图</strong>" in h
    assert "<code>Orchestrator</code>" in h
    assert "**" not in h and "`" not in h


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    fails = 0
    for f in fns:
        try:
            f()
            print("PASS", f.__name__)
        except AssertionError as e:
            fails += 1
            print("FAIL", f.__name__, "—", e)
        except Exception as e:  # noqa: BLE001
            fails += 1
            print("ERR ", f.__name__, "—", repr(e))
    print(f"{len(fns) - fails}/{len(fns)} passed")
    sys.exit(1 if fails else 0)
