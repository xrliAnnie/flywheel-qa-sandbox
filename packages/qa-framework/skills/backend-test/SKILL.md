# Backend Test (Generic Sample)

## Purpose

Run backend/API integration tests: execute test suites, download artifacts, validate results.

## Input

- `qa-config.yaml` → `api.base_url`, `api.openapi_spec`
- Skill config file → `{project}-test-suite.md` (test case table, validation rules)
- From agent → plan acceptance criteria, change type

## Steps

### Step 0: Read Skill Config

Read the project-specific config file (path from `domains[].config_file`).
Parse:
- API base URL (override from config or use `api.base_url`)
- Auth env var name (e.g., `API_TOKEN`)
- Test suite table
- Artifact validation rules

### Step 1: Pre-flight

1. Verify API is reachable: `curl -sf {base_url}/health`
2. Verify auth credentials available (env var set)
3. Verify test tools installed (e.g., curl, jq, test runner)
4. If any pre-flight fails → report as `infra_flake`

### Step 2: Run Regression Tests (Existing Suite)

Run each test case from the skill config's test suite table:

```
For each test case:
  1. Build request (method, endpoint, payload, headers)
  2. Execute request
  3. Record: status code, response time, response body
  4. Compare against expected result
  5. If artifact download needed: download and save
```

**Continue on failure** — run all tests even if some fail.

### Step 3: Run AC-Driven Tests (Plan-Specific)

For each acceptance criterion from the plan:
1. Generate test request based on AC description
2. Execute and validate
3. Map result back to AC

### Step 4: Validate Artifacts (if applicable)

If test cases produce downloadable artifacts:
1. Check file exists and size > threshold
2. Run validation command (from skill config)
3. Record validation result

### Step 5: Generate Report

```markdown
## Backend Test Report

| # | Test | Status | Time | Details |
|---|------|--------|------|---------|
| 1 | {label} | PASS/FAIL | {ms} | {detail} |

### Summary
- Total: {N}, Pass: {P}, Fail: {F}
- Failure classification: {product_bug: N, test_bug: N, infra_flake: N}
```

## Customization

The project-specific `{project}-test-suite.md` should contain:

### API Configuration
- Base URL (or env var name)
- Auth header format

### Test Suite Table
| # | Label | Endpoint | Method | Payload | Expected | Timeout |
|---|-------|----------|--------|---------|----------|---------|

### Artifact Validation
| Artifact | Validation Command | Threshold |
|----------|-------------------|-----------|

### Known Issues
- List of known bugs affecting test results
