#!/usr/bin/env python3
"""FLY-349 v2 engine — machine load gate (宁慢勿崩).

Annie's machine has a WindowServer-panic history (load 170-450 crashed it; the
operating rule is "load>30 收手"). The consumer pool's concurrency MUST bend to live
load. Pure decision function; the orchestrator reads 1-min load avg from `uptime` and
calls `decide()` before each note / batch.

States (with hysteresis to avoid flapping):
  - proceed  : load comfortably low → full configured concurrency
  - throttle : elevated → drop to serial (concurrency 1), video stays 1
  - pause    : high → do no new work; sleep and re-check until load recedes

Hysteresis: once throttled/paused we don't jump straight back to full on a single dip;
we require load below a lower resume threshold first (prev_action carries the state).
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class GateConfig:
    cores: int = 8
    video_concurrency: int = 1     # conservative default (first-10); back-apply may raise to 2, hard cap 4
    analysis_concurrency: int = 4  # image/text workers when proceeding (≤ min(16,cores-2))
    # relative (per-core) thresholds
    proceed_per_core: float = 1.0  # load < cores*1.0 → proceed
    pause_per_core: float = 2.0    # load ≥ cores*2.0 → pause
    # absolute crash-guard (Annie: "load>30 收手"); pause regardless of cores
    absolute_pause: float = 30.0
    # hysteresis: after throttle/pause, only return toward proceed once load < cores*resume_per_core
    resume_per_core: float = 0.75
    hard_video_cap: int = 4


def decide(load1: float, cfg: GateConfig, prev_action: str = "proceed") -> dict:
    cores = max(1, cfg.cores)
    proceed_at = cores * cfg.proceed_per_core
    pause_at = min(cores * cfg.pause_per_core, cfg.absolute_pause)
    resume_at = cores * cfg.resume_per_core

    # absolute crash-guard always wins
    if load1 >= cfg.absolute_pause:
        return _r("pause", 0, 0, f"load {load1:.1f} ≥ absolute_pause {cfg.absolute_pause} — 宁慢勿崩")

    if load1 >= pause_at:
        return _r("pause", 0, 0, f"load {load1:.1f} ≥ pause {pause_at:.1f}")

    # hysteresis: if we were throttled/paused, require a real recovery before proceeding
    if prev_action in ("pause", "throttle") and load1 >= resume_at:
        return _r("throttle", 1, 1, f"recovering: load {load1:.1f} ≥ resume {resume_at:.1f} (hysteresis: stay serial)")

    if load1 < proceed_at:
        vc = min(cfg.video_concurrency, cfg.hard_video_cap)
        return _r("proceed", vc, cfg.analysis_concurrency, f"load {load1:.1f} < proceed {proceed_at:.1f}")

    # proceed_at ≤ load < pause_at → throttle to serial
    return _r("throttle", 1, 1, f"load {load1:.1f} in [{proceed_at:.1f},{pause_at:.1f}) — serial")


def _r(action, video_c, analysis_c, reason):
    return {"action": action, "video_concurrency": video_c, "analysis_concurrency": analysis_c, "reason": reason}


import re as _re
_LOAD_RE = _re.compile(r"load averages?:?\s*([0-9]+(?:\.[0-9]+)?)")


def parse_load1(uptime_line: str) -> float:
    """Extract the 1-min load average from an `uptime` line.
    mac: '...load averages: 12.00 14.28 16.50' / linux: '...load average: 0.50, 0.40, 0.39'."""
    m = _LOAD_RE.search(uptime_line)
    if not m:
        raise ValueError(f"no load average in: {uptime_line!r}")
    return float(m.group(1))
