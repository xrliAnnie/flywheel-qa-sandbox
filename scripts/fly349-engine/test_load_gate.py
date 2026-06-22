#!/usr/bin/env python3
"""Tests for FLY-349 load gate. Run: python3 test_load_gate.py"""
import load_gate as L
ok = 0
def check(c, m):
    global ok
    assert c, "FAIL: " + m
    ok += 1
cfg = L.GateConfig(cores=8, video_concurrency=2, analysis_concurrency=4)

def test_proceed_when_low():
    d = L.decide(3.0, cfg, "proceed")
    check(d["action"] == "proceed", "low load -> proceed")
    check(d["video_concurrency"] == 2 and d["analysis_concurrency"] == 4, "full concurrency when proceeding")

def test_throttle_midband():
    d = L.decide(10.0, cfg, "proceed")  # 8 ≤ 10 < 16
    check(d["action"] == "throttle" and d["video_concurrency"] == 1, "midband -> throttle serial")

def test_pause_relative():
    d = L.decide(16.0, cfg, "proceed")  # ≥ cores*2 = 16 (but absolute_pause 30 is higher → relative wins at 16)
    check(d["action"] == "pause", "load ≥ cores*2 -> pause")
    check(d["video_concurrency"] == 0, "pause -> no work")

def test_absolute_crashguard():
    big = L.GateConfig(cores=32, video_concurrency=2)  # cores*2=64, but absolute 30 must win
    d = L.decide(31.0, big, "proceed")
    check(d["action"] == "pause", "absolute_pause 30 wins even on many-core box")

def test_hysteresis_no_instant_recovery():
    # was paused, load dips to 7 (< proceed 8) but ≥ resume 6 -> stay throttle, not proceed
    d = L.decide(7.0, cfg, "pause")
    check(d["action"] == "throttle", "hysteresis: don't jump pause->proceed on a small dip")
    # real recovery below resume (8*0.75=6) -> proceed
    d2 = L.decide(5.0, cfg, "pause")
    check(d2["action"] == "proceed", "below resume threshold -> proceed")

def test_video_hard_cap():
    cfg2 = L.GateConfig(cores=16, video_concurrency=10, hard_video_cap=4)
    d = L.decide(2.0, cfg2, "proceed")
    check(d["video_concurrency"] == 4, "video concurrency hard-capped at 4")

def test_parse_load_mac_and_linux():
    check(abs(L.parse_load1("21:10  up 2 days, load averages: 12.00 14.28 16.50") - 12.0) < 1e-9, "mac uptime parse")
    check(abs(L.parse_load1("10:00:00 up 1:00, 2 users, load average: 0.50, 0.40, 0.39") - 0.50) < 1e-9, "linux uptime parse")

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print(f"✅ ALL LOAD-GATE TESTS PASSED ({ok} assertions)")
