# QA Framework — Skill Interface Contract

All QA test skills must follow this contract to be compatible with the qa-parallel-executor agent.

## Input

1. **qa-config.yaml** — project configuration (loaded by the agent, available as `QA_*` env vars)
2. **Skill config file** — project-specific test details, path from `domains[].config_file`
3. **From agent** — plan path, acceptance criteria, change type classification

## Output

1. **Test execution results** — pass/fail with details for each test case
2. **Test report** — markdown, saved to `{QA_REPORT_DIR}/`
3. **Failure classification** — each failure labeled as: `product_bug` / `test_bug` / `infra_flake`

## Skill SKILL.md Structure

Each skill SKILL.md should follow this structure:

```markdown
# {Skill Name} (Generic)

## Purpose
{One sentence: what this skill tests}

## Input
- qa-config.yaml fields used: {list}
- Skill config file: {what it contains}
- From agent: {what the agent passes}

## Steps
Step 0: Read skill config, parse test parameters
Step 1: Pre-flight (environment checks)
Step 2: Execute test suite
Step 3: Validate results / artifacts
Step 4: Generate report

## Output
- Test report (markdown)
- Failure classification per test case

## Customization
{What the project-specific config file should contain}
```

## Project Config File Structure

Each project provides a `{project}-{skill}.md` file with:
- Test suite definitions (tables of test cases)
- Environment-specific configuration (API URLs, credentials as env var names)
- Validation rules and thresholds
- Known issues affecting test results

**The generic SKILL.md should NOT be modified.** All project-specific content goes in the config file.

## Failure Classification Rules

| Condition | Classification |
|-----------|---------------|
| API returns error for valid request | product_bug |
| Expected output missing or invalid | product_bug |
| Test script syntax/import error | test_bug |
| Assertion targets wrong field/endpoint | test_bug |
| Connection refused / timeout | infra_flake |
| Browser/process crash | infra_flake |
