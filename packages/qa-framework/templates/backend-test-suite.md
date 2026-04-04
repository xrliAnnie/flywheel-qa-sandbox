# Backend Test Suite — {project}

## API Configuration

- **Base URL**: `{from qa-config.yaml api.base_url or override here}`
- **Auth**: env var `{AUTH_ENV_VAR_NAME}` (header: `Authorization: Bearer $AUTH_ENV_VAR_NAME`)

## Default Test Suite

| # | Label | Endpoint | Method | Payload | Expected | Timeout |
|---|-------|----------|--------|---------|----------|---------|
| 1 | Health Check | /health | GET | - | 200 OK | 10s |
| 2 | {your test 1} | {path} | {method} | {json or -} | {status + body check} | {timeout} |
| 3 | {your test 2} | {path} | {method} | {json or -} | {status + body check} | {timeout} |

## Artifact Validation (optional)

If your API produces downloadable artifacts:

| Artifact | Download Path | Validation Command | Min Size |
|----------|--------------|-------------------|----------|
| {type} | {URL pattern} | {command} | {bytes} |

## Known Issues

- {List any known bugs or quirks that affect test results}
- {e.g., "Endpoint X returns 503 during deployment windows"}
