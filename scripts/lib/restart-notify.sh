#!/usr/bin/env bash
# FLY-1603: truthful terminal notification helpers for restart-services.sh.
# Sourceable on macOS Bash 3.2. Do not install shell options or global traps.

rn_format_duration() {
    local seconds="${1:-}"
    if ! [[ "$seconds" =~ ^[0-9]+$ ]]; then
        printf 'unknown\n'
        return 0
    fi

    if (( seconds >= 60 )); then
        printf '%dm%02ds\n' "$((seconds / 60))" "$((seconds % 60))"
    else
        printf '%ds\n' "$seconds"
    fi
    return 0
}

rn_parse_count() {
    local field="${1:-}"
    local machine_line="${2:-}"
    local skipped_field="" failed_field="" total_field="" extra=""

    case "$field" in
      skipped|failed|total) ;;
      *) printf 'invalid\n'; return 0 ;;
    esac
    if [[ "$machine_line" == *$'\n'* ]] \
      || ! [[ "$machine_line" =~ ^skipped:[0-9]+[[:space:]]+failed:[0-9]+[[:space:]]+total:[0-9]+$ ]]; then
        printf 'invalid\n'
        return 0
    fi

    IFS=' ' read -r skipped_field failed_field total_field extra <<< "$machine_line"
    if [[ -n "$extra" ]]; then
        printf 'invalid\n'
        return 0
    fi
    case "$field" in
      skipped) printf '%s\n' "${skipped_field#skipped:}" ;;
      failed) printf '%s\n' "${failed_field#failed:}" ;;
      total) printf '%s\n' "${total_field#total:}" ;;
    esac
    return 0
}

rn_normalize_lead_names() {
    local expected_count="${1:-}"
    local captured_csv="${2:-}"
    local actual_count=0
    local remainder=""

    if ! [[ "$expected_count" =~ ^[0-9]+$ ]]; then
        printf '名单记录不完整(见日志)\n'
        return 0
    fi
    if (( expected_count == 0 )); then
        printf '\n'
        return 0
    fi

    if [[ -n "$captured_csv" ]]; then
        actual_count=1
        remainder="$captured_csv"
        while [[ "$remainder" == *,* ]]; do
            remainder="${remainder#*,}"
            actual_count=$((actual_count + 1))
        done
    fi

    if (( actual_count == expected_count )); then
        printf '%s\n' "$captured_csv"
    elif [[ -n "$captured_csv" ]]; then
        printf '名单记录不完整(见日志；已记录: %s)\n' "$captured_csv"
    else
        printf '名单记录不完整(见日志)\n'
    fi
    return 0
}

rn_probe_bridge_health() {
    local bridge_url="${1:-}"
    local body_tmp="" timing="" milliseconds="" probe_state="fail"

    if ! body_tmp=$(mktemp "${TMPDIR:-/tmp}/flywheel-restart-health.XXXXXX" 2>/dev/null); then
        printf 'fail\t-\n'
        return 0
    fi

    if timing=$(LC_ALL=C curl -sf --max-time 5 -o "$body_tmp" -w '%{time_total}' \
        "${bridge_url%/}/health" 2>/dev/null) \
      && jq -e '.ok == true' < "$body_tmp" >/dev/null 2>&1 \
      && [[ "$timing" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        milliseconds=$(LC_ALL=C awk -v t="$timing" 'BEGIN { printf "%.0f", t * 1000 }' 2>/dev/null) || milliseconds=""
        if [[ "$milliseconds" =~ ^[0-9]+$ ]]; then
            probe_state="ok"
        fi
    fi

    rm -f "$body_tmp" 2>/dev/null || true
    if [[ "$probe_state" == "ok" ]]; then
        printf 'ok\t%s\n' "$milliseconds"
    else
        printf 'fail\t-\n'
    fi
    return 0
}

rn_render_completion_message() {
    local old_sha="${1:-}"
    local new_sha="${2:-}"
    local reason="${3:-}"
    local lead_total="${4:-}"
    local lead_failed="${5:-}"
    local lead_skipped="${6:-}"
    local failed_names="${7:-}"
    local skipped_names="${8:-}"
    local lead_result_state="${9:-}"
    local lead_result_detail="${10:-}"
    local bridge_state="${11:-}"
    local bridge_ms="${12:-}"
    local duration_str="${13:-}"
    local watcher_state="${14:-healthy}"
    local watcher_detail="${15:-}"
    local body_new="${16:-}" body_adopted="${17:-}" body_unknown="${18:-}"
    local launchd_summary="${19:-}"
    local bridge_startup_state="${20:-unknown}"
    local old_display="" new_display="" first_line="" lead_line="" body_line="" bridge_line="" watcher_line=""
    local lead_success=0 clean_leads=false

    [[ -n "$reason" ]] || reason="unknown"
    [[ -n "$duration_str" ]] || duration_str="unknown"
    if [[ -n "$old_sha" ]]; then
        old_display="\`${old_sha:0:7}\`"
    else
        old_display="(首次部署)"
    fi
    if [[ -n "$new_sha" ]]; then
        new_display="\`${new_sha:0:7}\`"
    else
        new_display="(未知版本)"
    fi

    if ! [[ "$lead_total" =~ ^[0-9]+$ ]] \
      || ! [[ "$lead_failed" =~ ^[0-9]+$ ]] \
      || ! [[ "$lead_skipped" =~ ^[0-9]+$ ]]; then
        lead_total=0
        lead_failed=0
        lead_skipped=0
        lead_result_state="unreadable"
    fi
    case "$lead_result_state" in
      known|wave_not_run|unreadable) ;;
      *) lead_result_state="unreadable" ;;
    esac
    case "$watcher_state" in
      healthy|missing_plist|bootstrap_failed|probe_failed|unverifiable) ;;
      *) watcher_state="unverifiable"; watcher_detail="watcher outcome contract unreadable" ;;
    esac
    case "$bridge_startup_state" in
      passed|unknown) ;;
      *) bridge_startup_state="unknown" ;;
    esac
    case "$bridge_state" in
      ok)
        if ! [[ "$bridge_ms" =~ ^[0-9]+$ ]]; then
            bridge_state="unavailable"
            bridge_ms="-"
        fi
        ;;
      unavailable) bridge_ms="-" ;;
      *) bridge_state="unavailable"; bridge_ms="-" ;;
    esac
    watcher_detail=$(printf '%s' "$watcher_detail" | tr '\r\n' '  ')
    if [[ "$lead_result_state" == "known" ]] \
      && (( lead_failed + lead_skipped > lead_total )); then
        lead_result_state="unreadable"
    fi

    if [[ "$lead_result_state" == "known" ]] && (( lead_total > 0 )); then
        lead_success=$((lead_total - lead_failed - lead_skipped))
        if (( lead_failed == 0 && lead_skipped == 0 )); then
            clean_leads=true
        fi
    fi

    if [[ "$clean_leads" == "true" && "$watcher_state" == "healthy" \
      && "$bridge_startup_state" == "passed" ]]; then
        first_line="✅ Flywheel 全量重启完成 (reason=${reason})"
    elif [[ "$watcher_state" != "healthy" || "$lead_result_state" != "known" ]] \
      || (( lead_failed > 0 || lead_skipped > 0 )); then
        first_line="⚠️ Flywheel 全量重启结束 — degraded (reason=${reason})"
    elif (( lead_total == 0 )); then
        first_line="⚠️ Flywheel 全量重启结束 — 未发现 Lead 候选 (reason=${reason})"
    else
        first_line="⚠️ Flywheel 全量重启结束 — 状态未知 (reason=${reason})"
    fi

    case "$lead_result_state" in
      wave_not_run)
        [[ -n "$lead_result_detail" ]] || lead_result_detail="原因记录失败,见部署日志"
        lead_line="Lead: 重启波次未执行(${lead_result_detail}),Lead 总数未知"
        ;;
      unreadable)
        lead_line="Lead: 重启结果无法读取(统计合同解析失败),请查部署日志"
        ;;
      known)
        if (( lead_total == 0 )); then
            lead_line="Lead: 未发现可重启候选(0)"
        elif (( lead_failed == 0 && lead_skipped == 0 )); then
            lead_line="Lead: ${lead_success}/${lead_total} supervisor 换代收敛(body 见『本体』行;未单独探测 Discord 可达性)"
        else
            lead_line="Lead: ${lead_total} 个里 ${lead_success} 个成功"
            if (( lead_failed > 0 )); then
                [[ -n "$failed_names" ]] || failed_names="名单记录不完整(见日志)"
                lead_line="${lead_line}、${lead_failed} 个失败: ${failed_names}"
            fi
            if (( lead_skipped > 0 )); then
                [[ -n "$skipped_names" ]] || skipped_names="名单记录不完整(见日志)"
                lead_line="${lead_line}、${lead_skipped} 个跳过(无 manifest): ${skipped_names}"
            fi
        fi
        ;;
    esac

    body_line="本体: 观测失败(未知)"
    if [[ "$lead_result_state" == "known" ]] && (( lead_total > 0 )) \
      && [[ "$body_new" =~ ^[0-9]+$ ]] \
      && [[ "$body_adopted" =~ ^[0-9]+$ ]] \
      && [[ "$body_unknown" =~ ^[0-9]+$ ]] \
      && (( body_new + body_adopted + body_unknown == lead_success )); then
        if (( body_adopted > 0 )); then
            body_line="⚠️ 本体: ${body_new} 新建 / ${body_adopted} 接管(未换) / ${body_unknown} 未知"
        else
            body_line="本体: ${body_new} 新建 / 0 接管(未换) / ${body_unknown} 未知"
        fi
    fi

    if [[ "$bridge_startup_state" == "passed" && "$bridge_state" == "ok" ]]; then
        bridge_line="Bridge: healthy (启动健康检查通过；Lead 波前 /health 实测 ${bridge_ms}ms)"
    elif [[ "$bridge_startup_state" == "passed" ]]; then
        bridge_line="Bridge: 启动健康检查通过；Lead 波前延迟观测未取得"
    elif [[ "$bridge_state" == "ok" ]]; then
        bridge_line="Bridge: 启动健康状态未知；Lead 波前 /health 实测 ${bridge_ms}ms"
    else
        bridge_line="Bridge: 启动健康状态未知；Lead 波前延迟观测未取得"
    fi

    if [[ "$watcher_state" == "healthy" ]]; then
        watcher_line="cmux watcher: healthy${watcher_detail:+ (${watcher_detail})}"
    else
        watcher_line="cmux watcher: ⚠️ ${watcher_state}${watcher_detail:+ (${watcher_detail})}"
    fi

    printf '%s\n版本: %s → %s\n%s\n%s\n%s\n%s\n总耗时: %s' \
        "$first_line" "$old_display" "$new_display" "$lead_line" "$body_line" "$bridge_line" "$watcher_line" "$duration_str"
    if [[ -n "$launchd_summary" ]]; then
        printf '\nlaunchd: %s' "$launchd_summary"
    fi
    if [[ "$first_line" == *"degraded"* ]]; then
        printf '\n详情见 <#1518793447165661254>'
    fi
    printf '\n'
    return 0
}
