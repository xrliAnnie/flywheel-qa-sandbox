# FLY-66: QA Framework Extraction Research

**Objective**: Extract GeoForge3D's QA Agent v2 (GEO-308) into a reusable framework in Flywheel (`packages/qa-framework`), enabling any project to implement parallel QA testing with skill-based test orchestration.

**Status**: Research Complete  
**Date**: 2026-04-03  
**Scope**: Thorough analysis of GeoForge3D QA implementation to identify what's generic, what's hardcoded, and what needs redesign.

---

## Executive Summary

GeoForge3D's QA Agent v2 is a sophisticated 5-step orchestration system that combines feature verification with automated skill-based regression testing. The protocol is heavily hardcoded to GeoForge3D but has a **clear generic core**:

**Generic Elements (40% of code)**:
- 5-step execution flow with SQLite state tracking
- Skill file update mechanism
- Test result persistence and archiving
- Regression test runner selection logic

**Project-Specific Elements (60% of code)**:
- Skill files themselves (backend-integration-test, frontend-integration-test, e2e-integration-test)
- Paths to GeoForge3D directories and files
- OpenAPI spec location and format
- Shopify store configuration (credentials, product variants, payment test cards)
- 3D model validation logic (3MF format, GLB validation)
- Specific test suites and performance thresholds

**Extraction Difficulty**: **MODERATE**. The generic protocol is clean but requires significant parameterization and 2-3 new components (project-config.yaml, skill registry, test environment abstraction).

---

## 1. QA Agent Protocol Analysis

### 1.1 What's Generic

**5-Step Flow** (qa-parallel-executor.md):
1. **Onboard**: Verify environment, read plan, read qa-context
2. **Analyze + Plan**: Extract acceptance criteria, classify changes, generate test cases
3. **Research**: Read OpenAPI spec, domain docs, historical notes
4. **Write + Execute Tests**: Create ad hoc tests, loop on failures, track iterations
5. **Finalize**: Update skill files, run regression, generate final report

This flow works for ANY project. The steps are:
- Well-defined entry/exit conditions
- State-tracked in SQLite
- Reusable across domains (backend, frontend, full-chain)

**Skill Execution Model**:
- Skills are referenced by name: `onboard-qa`, `backend-integration-test`, `frontend-integration-test`, `e2e-integration-test`
- Skills are loaded via `Skill(skill="skill-name")` or `Read("{PROJECT_ROOT}/.claude/skills/{skill-name}/SKILL.md")`
- Skills are self-contained and encapsulate test methodology

**State Tracking** (state.sh + schema-v6.sql):
- Agent lifecycle: spawned → running → completed/failed/stopped
- Step tracking: pending → in_progress → completed/skipped/failed
- Artifact recording: test reports, research docs, regression results
- Critical writes use `state_critical` (retry 3x)
- Telemetry writes use `state_try` (fail-open)

**Worktree Boundary**:
- Test execution happens in worktree (`{WORKTREE_PATH}/tmp-qa-tests/`)
- Documents persist in PROJECT_ROOT (`product/doc/qa/...`)
- Narrow exception: only `product/doc/qa/` on PROJECT_ROOT; everything else in worktree

### 1.2 What's Hardcoded to GeoForge3D

#### Paths & Directories
```
PROJECT_ROOT = /Users/xiaorongli/Dev/GeoForge3D
BACKEND_DIR = $PROJECT_ROOT/product/GeoForge3D-Backend
FRONTEND_DIR = $PROJECT_ROOT/product/GeoForge3D-Frontend

OpenAPI spec: $BACKEND_DIR/api-gateway/openapi-spec.yaml
GCS bucket: gs://geoforge3d-artifacts-geoforge3d
Test scripts: test_scripts/playwright/ (hardcoded CLI paths)
```

#### Skills
- `onboard-qa`: GeoForge3D product overview, Shopify store info, test card numbers, known bugs
- `backend-integration-test`: API endpoints, GCS artifacts, 3MF validation, performance SLAs
- `frontend-integration-test`: Shopify checkout flow, Mapbox integration, React form filling
- `e2e-integration-test`: Full chain from Shopify purchase → webhook → backend job → 3MF

#### API Contracts
- Hardcoded default API URL: `https://geoforge3d-api-5csvf2blaa-uw.a.run.app`
- Job schema: `{address, product_style_id, product_size_id, zoom_factor, job_type, config_name, filter_strategy, customization}`
- Job status endpoints: `GET /v1/jobs`, `GET /v1/jobs/{id}`, `POST /v1/jobs`
- Artifact bucket: `gs://geoforge3d-artifacts-geoforge3d`

#### Test Suites
```
Backend Default Suite:
| # | Style | Type | Config | Zoom | Timeout |
|---|-------|------|--------|------|---------|
| 1 | osm2world | PREVIEW | city_preview-v1 | 0.05 | 600s |
| 2 | osm2world | FULL | city_default-v1 | 0.05 | 1200s |
| 3 | terrain_only | PREVIEW | terrain_default-v1 | 1.0 | 600s |
| 4 | terrain_only | FULL | terrain_default-v1 | 1.0 | 900s |

Performance Suite (with SLAs):
| # | Style | Type | Config | Zoom | Timeout | SLA |
|---|-------|------|--------|------|---------|-----|
| 1 | osm2world | PREVIEW | city_preview-v1 | 0.7 | 600s | 300s |
| 2 | osm2world | PREVIEW | city_preview-v1 | 0.7 | 600s | 300s |
| 3 | osm2world | FULL | city_default-v1 | 0.35 | 1200s | 900s |
| 4 | terrain_only | FULL | terrain_default-v1 | 1.0 | 900s | 600s |
```

#### Shopify Configuration
```
Store URL: https://geoforge3d.myshopify.com
Store Password: ratwah
Product: 3D Custom Map Art
Variant IDs: 
  - 4"x5": 47635229769960
  - 8"x10": 47452925559016
  - 12"x15": 47452925591784
  - 16"x20": 47452925624552
Test Card Numbers:
  - 1: success
  - 2: failure
  - 3: error
Test Email: xrliannie.shopping@gmail.com
```

#### Validation Logic
- 3MF file size thresholds: Terrain PREVIEW > 50KB, Terrain FULL > 100KB, City PREVIEW > 100KB, City FULL > 500KB
- ZIP integrity: `unzip -t {file}`
- Model file present: `unzip -l {file} | grep "3D/3dmodel.model"`
- GLB validation: Custom Python validator at `shared/validators/glb_validator.py`

### 1.3 Skill Reference Model

Skills are referenced by **name only**, not by path. Resolution is:
```
1. Skill(skill="{name}") via MCP/remote execution
2. Fallback: Read("{PROJECT_ROOT}/.claude/skills/{name}/SKILL.md")
```

Skills are NOT dynamically discovered — they must be explicitly listed in agent definitions:
```yaml
# qa-parallel-executor.md
skills:
  - onboard-qa
  - backend-integration-test
  - frontend-integration-test
  - e2e-integration-test
```

**Problem for extraction**: Each skill is heavily customized for GeoForge3D. A generic framework would need:
- Parameterizable skill templates (e.g., "backend test structure")
- Project-config.yaml to override skill behaviors
- Fallback mechanisms for missing skills

---

## 2. Sample Skills Analysis

### 2.1 onboard-qa

**What's Generic**:
- Structure: Product overview, test commands, known issues, test report format
- State tracking: Read plan, verify environment
- Fallback patterns: Skill() then Read()

**What's Project-Specific**:
- **Section 1 (Product Overview)**:
  ```
  GeoForge3D generates 3D geographic models from real-world map data...
  Two engines: TouchTerrain (terrain-only), OSM2World (city models)
  ```
  → Would become: User-provided markdown in `project-config.yaml`

- **Section 2 (Store Information)**:
  ```
  Store URL: https://geoforge3d.myshopify.com
  Store Password: ratwah
  Product Page: https://geoforge3d.myshopify.com/products/3d-custom-map-art
  Theme ID: 150326149352
  Variant IDs: {table}
  Test Card Numbers: 1=success, 2=fail, 3=error
  ```
  → Would become: `project.frontend.shopify` in config

- **Section 3 (Test Commands)**:
  ```
  - backend-integration-test: Tests API → Cloud Run Job → 3MF file
  - frontend-integration-test: Tests Shopify map customizer UI
  - e2e-integration-test: Full chain from checkout to 3MF validation
  ```
  → Would become: Dynamic list based on available skills in `project.skills`

- **Section 4 (Playwright + Shopify Known Issues)**:
  ```
  Mapbox breaks browser_snapshot → Use browser_evaluate
  Checkout PCI iframes → Use page.frame({name}) + frame.evaluate()
  React form filling → Keyboard-based input with {delay: 30}
  ```
  → Would become: `project.frontend.playwright-workarounds`

- **Section 5 (Known Bugs)**:
  ```
  No known open bugs as of 2026-02-16
  For history, see: product/doc/frontend/test-reports/Fixed/README.md
  ```
  → Would become: Dynamic link to `product/doc/{domain}/test-reports/Fixed/README.md`

**Recommended "Sample" Template for onboard-qa**:
```markdown
# QA Tester Onboarding (Generic Template)

## 1. Product Overview
{project.description} (from project-config.yaml)

## 2. Environment Setup
{project.environments} (from project-config.yaml)

## 3. Test Commands
Dynamically listed from available skills:
- backend-integration-test
- frontend-integration-test
- e2e-integration-test
[Only list skills present in project.skills]

## 4. Known Workarounds
{project.frontend.playwright_workarounds} (from project-config.yaml)

## 5. Known Bugs
See: {project.doc_path}/test-reports/Fixed/README.md

## 6. Not Included in This Onboarding
{project.onboarding_exclusions} (from project-config.yaml)
```

### 2.2 backend-integration-test

**What's Generic**:
- 7-step execution flow: Verify context, pre-flight, resolve API URL, run test suite, download artifacts, validate files, report
- Test suite structure: Table of tests with parameters (style, type, config, timeout)
- File validation: ZIP integrity, file size checks
- Error handling: "Continue on failure" principle
- Summary report format: HTML table with status, time, job ID, file sizes, validation results

**What's Project-Specific**:
- **Step 0.5: API URL Resolution**:
  ```bash
  API_URL=$(gcloud run services describe {slug}-geoforge3d-api ...)
  # Default: https://geoforge3d-api-5csvf2blaa-uw.a.run.app
  ```
  → Would become: `project.backend.api_url` with parameterization

- **Step 1b: Download Directory**:
  ```bash
  DOWNLOAD_DIR=~/Downloads/GeoForge3D/integration-tests/${TIMESTAMP}
  ```
  → Would become: `project.backend.download_dir_template`

- **Step 2: Default Test Suite**:
  ```
  | # | Label | Style | Type | Config | Zoom | Address | Filter | Timeout |
  |---|-------|-------|------|--------|------|---------|--------|---------|
  | 1 | City PREVIEW | osm2world | PREVIEW | city_preview-v1 | 0.05 | Times Square... | height_tagged | 600s |
  ...
  ```
  → Would become: `project.backend.test_suites.default` (list of test case objects)

- **Step 2a: Performance Suite**:
  ```
  | # | Label | ... | SLA |
  |---|-------|-----|-----|
  | 1 | City PREVIEW NYC | ... | 300s |
  ...
  ```
  → Would become: `project.backend.test_suites.perf` (list with SLA values)

- **Step 3b: Job Submission Schema**:
  ```json
  {
    "address": "<address>",
    "product_style_id": "<style>",
    "product_size_id": "small_square",
    "zoom_factor": <zoom>,
    "job_type": "<type>",
    "config_name": "<config>",
    "filter_strategy": "<filter>",
    "customization": { ... }
  }
  ```
  → Would become: `project.backend.job_schema` (template JSON)

- **Step 4a: GCS Bucket**:
  ```bash
  gs://geoforge3d-artifacts-geoforge3d/${JOB_ID}/artifacts/final_model.3mf
  ```
  → Would become: `project.backend.artifact_bucket_template`

- **Step 5: Validation Thresholds**:
  ```
  Terrain PREVIEW: > 50KB
  Terrain FULL: > 100KB
  City PREVIEW: > 100KB
  City FULL: > 500KB
  ```
  → Would become: `project.backend.validation.file_size_thresholds` (object keyed by style/type)

- **Step 5d: GLB Validator**:
  ```bash
  python "${BACKEND_DIR}/shared/validators/glb_validator.py" "$GLB_FILE"
  ```
  → Would become: `project.backend.validators.glb_script_path` (optional, skill-specific)

**Recommended "Sample" Template for backend-integration-test**:
```markdown
# Backend Integration Test (Generic Template)

## Step 0: Determine Context
[Same — determine how invoked]

## Step 0.5: Resolve API URL
{project.backend.api_url} or {project.backend.api_url_lookup_script}

## Step 1: Pre-flight
[Same — verify gcloud auth, setup download dir]

## Step 2: Default Test Suite
{project.backend.test_suites.default} (from project-config.yaml)
[Dynamically generate table]

## Step 2a: Performance Test Suite (--perf only)
{project.backend.test_suites.perf} (from project-config.yaml)
[Only if suite defined]

## Step 3: Execute Tests Sequentially
For each test:
3a. Refresh token
3b. Submit job via POST to {project.backend.api_url}/v1/jobs with schema {project.backend.job_schema}
3c. Poll for completion (resolve endpoint from project.backend.poll_endpoint_template)
3d. Record elapsed time and check SLA

## Step 4: Download Artifacts
For each completed job:
4a. Download from {project.backend.artifact_bucket_template}/{JOB_ID}/artifacts/
4b. Record file sizes

## Step 5: Validate Files
5a. File size check against {project.backend.validation.file_size_thresholds}
5b. ZIP integrity: unzip -t {file}
5c. Model file exists: check project.backend.validation.model_file_path
5d. Optional GLB validation (if {project.backend.validators.glb_script_path} defined)

## Step 6: Summary Report
[Same — generate HTML/markdown table]
```

### 2.3 frontend-integration-test

**What's Generic**:
- Step-by-step UI navigation workflow
- Screenshot capture and management
- Issue tracking with severity levels
- Regression testing checklist (known bugs list)
- Failure continuation principle ("NEVER fail-fast")
- Report format with step results, issues detail, severity summary

**What's Project-Specific**:
- **Configuration**:
  ```
  Store URL: https://geoforge3d.myshopify.com
  Store Password: ratwah
  Product Page: https://geoforge3d.myshopify.com/products/3d-custom-map-art
  Test Address: Times Square, New York, NY
  Test Email: xrliannie.shopping@gmail.com
  ```
  → `project.frontend.store_config`

- **Workarounds** (Playwright MCP + Shopify):
  ```
  1. Mapbox: Use browser_evaluate instead of browser_snapshot
  2. React 18: Use simulated event property
  3. Checkout PCI iframes: Use page.frame({name}) + frame.evaluate()
  4. Shopify forms: Keyboard-based input with {delay: 30}
  ```
  → `project.frontend.playwright_workarounds`

- **Test Card Numbers**:
  ```
  Card 1: success
  Card 2: failure
  Card 3: error
  ```
  → `project.frontend.test_payment_cards`

- **UI Element Selectors**:
  ```
  Search input: input[placeholder="Enter address, city, or ZIP code"]
  Color palette tab: button[data-tab="labels"]
  Map preview container: .preview-container or [class*="preview"]
  ```
  → `project.frontend.ui_selectors` (map of component → CSS selector)

- **Preview Generator**:
  ```
  Async 3D preview with polling every 2s, timeout 3min
  Success state: div[role="img"][aria-label*="3D preview"] + canvas
  Error state: .text-red-500
  ```
  → `project.frontend.preview_generator_config` (polling interval, timeout, selectors)

- **Size Options**:
  ```
  4"x5", 8"x10", 12"x15", 16"x20"
  ```
  → `project.frontend.product_sizes`

- **Frame Options**:
  ```
  None, Black, White, Natural, Walnut
  ```
  → `project.frontend.product_frames`

- **Known Bugs Regression List**:
  ```
  #1: Reverse geocoding HTTP 422
  #2: Size selection changed preview dimensions
  #3: Variant matching fails
  ...
  ```
  → `project.frontend.known_bugs` (list of objects with title, description, fixed_date, regression_selector)

- **Test Steps**:
  ```
  Step 0: Setup (navigate, enter password)
  Step 1: Navigate to Product Page
  Step 2a-2d: Map Tab (search, current position, popular places, zoom)
  Step 3a-3b: Labels Tab (edit, lock)
  Step 4: Color Palette Tab
  Step 4a-4b: Preview (generate, return)
  Step 5a: Size Tab (preview stability)
  Step 6a: Frame Tab (preview stability)
  Step 8a: Cart Contents
  Step 9a-9c: Checkout (contact, delivery, payment)
  ```
  → `project.frontend.test_steps` (list of step definitions)

- **Screenshot Directory**:
  ```
  /Users/xiaorongli/Dev/GeoForge3D/test-screenshots
  Created fresh at start, cleaned up at end if no CRITICAL/HIGH issues
  ```
  → `project.frontend.screenshot_dir_template`

**Recommended "Sample" Template for frontend-integration-test**:
```markdown
# Frontend Integration Test (Generic Template)

## Configuration
{project.frontend.store_config} — credentials, URLs, test data

## Critical Workarounds
{project.frontend.playwright_workarounds} — Playwright MCP + {framework} specific patterns

## Test Flow
For each step in {project.frontend.test_steps}:
1. Navigate/interact using workarounds
2. Verify expected state via browser_evaluate (not browser_snapshot if {framework} breaks it)
3. Capture screenshot to {project.frontend.screenshot_dir_template}/{step_name}.png
4. Log any issues with {severity}

## Regression Checks
From {project.frontend.known_bugs}:
- For each known bug:
  - Verify it is NOT present (search for regression_selector)
  - If found, log as HIGH severity

## Issue Tracking
Maintain list with fields: Step, Expected, Actual, Severity, Screenshot path

## Report Generation
Write markdown report to {project.frontend.test_report_dir}/New/{timestamp}-{VERSION}-frontend-integration-test.md
Include:
- Step results table
- Issues detail with all fields
- Summary by severity
- Recommendations

## Screenshot Cleanup
If no CRITICAL or HIGH issues: delete {project.frontend.screenshot_dir_template}
Otherwise: keep for debugging
```

### 2.4 e2e-integration-test

**What's Generic**:
- Multi-phase flow: Frontend checkout → Bridge (order lookup) → Backend job tracking → Validation → Report
- Phase-based error handling: Continue in Phase 1, but skip Phases 2-4 if Phase 1 fails
- Order tracking: Extract order number from confirmation page
- Webhook polling with backoff: Exponential backoff up to 120s for job creation
- 3MF validation: Same checks as backend-integration-test

**What's Project-Specific**:
- **Frontend Phase** (Playwright):
  ```
  Same as frontend-integration-test but simplified:
  - Navigate to store
  - Customize product
  - Add to cart
  - Checkout with test credentials
  - Extract order number from confirmation
  ```
  → `project.frontend.e2e_test_steps` (simplified subset)

- **Bridge Phase** (Shopify Admin API):
  ```
  Query Shopify Admin API to find order by number
  Extract order.id, line_item.id
  Verify line item properties:
    - _Style: osm2world | terrain_only
    - _Config Name: city_preview-v1 | city_default-v1 | terrain_default-v1
    - _Bounding Box: JSON {north, south, east, west}
    - _sizeId, _paletteId, _labels, Address
  Construct external_id: shopify_order_{order_id}_item_{line_item_id}
  ```
  → `project.frontend.shopify_admin_api_version` (e.g., "2024-10")
  → `project.frontend.shopify_webhook_fields` (list of expected property keys)

- **Backend Phase**:
  ```
  Poll GET /v1/jobs?external_id={external_id} with exponential backoff
  Once job found: poll GET /v1/jobs/{job_id} until completed
  Max wait: 120s for job creation, 1200s for completion
  ```
  → `project.backend.webhook_polling_config` (max_wait, interval, backoff_cap)
  → `project.backend.job_status_endpoints` (query template, status field name)

- **Validation Phase**:
  ```
  Download from {project.backend.artifact_bucket_template}/{JOB_ID}/artifacts/
  Same validation as backend-integration-test
  ```

- **Report**:
  ```
  5-phase summary: Frontend, Bridge, Backend, Validation, Report
  Each phase with pass/fail and key metrics
  ```

**Recommended "Sample" Template for e2e-integration-test**:
```markdown
# Full-Chain E2E Integration Test (Generic Template)

## Prerequisites
{project.frontend.store_config}
{project.backend.api_url}
Shopify Admin API token: {project.frontend.shopify_admin_api_token_env}

## Phase 1: Frontend Checkout (Playwright MCP)
[Execute {project.frontend.e2e_test_steps}]
Extract order number from {project.frontend.order_confirmation_selector}

## Phase 2: Bridge (Shopify Admin API)
Query {project.frontend.shopify_admin_api_base}/orders.json?name=#{order_number}
Extract: order.id, line_item.id
Verify line item has {project.frontend.shopify_webhook_fields}
Construct external_id: shopify_order_{order_id}_item_{line_item_id}

## Phase 3: Backend Job Tracking
Poll GET {project.backend.job_query_endpoint}?external_id={external_id}
With backoff: {project.backend.webhook_polling_config}
Once found, poll GET {project.backend.job_status_endpoint} until completed

## Phase 4: 3MF Validation
[Same as backend-integration-test]

## Phase 5: Report
[Summarize all 5 phases with metrics and pass/fail]
```

---

## 3. Orchestrator: What Needs to Change

### 3.1 config.sh Analysis

**What's Generic** (Reusable):
- Lock mechanism: `acquire_lock`, `release_lock`, `wait_for_lock` functions
- Limits configuration: MAX_CONCURRENT_AGENTS, ENV_LEASE_TIMEOUT, DOCS_LOCK_TIMEOUT, RECONCILE_INTERVAL
- Version management: `get_feature_version`, `bump_feature_version` functions
- CLAUDE_MODEL setting

**What's GeoForge3D-Specific** (Must Parameterize):
```bash
# Hardcoded paths
PROJECT_ROOT="/Users/xiaorongli/Dev/GeoForge3D"
BACKEND_DIR="$PROJECT_ROOT/product/GeoForge3D-Backend"
FRONTEND_DIR="$PROJECT_ROOT/product/GeoForge3D-Frontend"

# Watch paths
BACKEND_NEW="$PROJECT_ROOT/product/doc/backend/plan/new"
FRONTEND_NEW="$PROJECT_ROOT/product/doc/frontend/plan/new"
QA_NEW="$PROJECT_ROOT/product/doc/qa/plan/new"
DESIGNER_NEW="$PROJECT_ROOT/product/doc/designer/plan/new"
HANDOFF_NEW="$PROJECT_ROOT/product/doc/designer/handoff/new"

# QA Parallel settings
QA_PARALLEL_ENABLED=true
QA_PARALLEL_MAX=1
QA_MAX_ATTEMPTS=3

# Version file
VERSION_FILE="$PROJECT_ROOT/product/doc/VERSION"
```

**For Multi-Project Support**, config.sh should:
1. Load a `project-config.yaml` at project root
2. Extract PROJECT_ROOT, BACKEND_DIR, FRONTEND_DIR from config
3. Generate watch paths dynamically based on enabled domains
4. Support multiple profiles (default, dev, ci)

**Changes Required**:
```bash
# Add before sourcing lock.sh:
PROJECT_CONFIG="${PROJECT_ROOT:-.}/project-config.yaml"
if [ -f "$PROJECT_CONFIG" ]; then
    # Parse YAML and set variables
    # (requires yq or similar YAML parser)
    source <(yq eval -p yaml -o bash "$PROJECT_CONFIG")
else
    echo "ERROR: project-config.yaml not found at $PROJECT_CONFIG" >&2
    return 1
fi
```

### 3.2 state.sh Analysis

**What's Generic**:
- SQL helpers: `_sql`, `sql_escape` (low-level database interface)
- Failure wrappers: `state_critical`, `state_try` (3-tier reliability)
- Database initialization: `init_step_templates` (idempotent seeding)
- Agent lifecycle functions: `start_step`, `complete_step`, `fail_step`, `skip_step`
- Artifact recording: `add_artifact`, `get_artifacts`, `get_agent_steps`

**What's GeoForge3D-Specific**:
- Step template definitions for agent types:
  ```bash
  # executor: 8 steps (Verify Environment → Brainstorm → Research → Plan → Implement → Codex Review → Pre-merge → Ship)
  # designer: 5 steps
  # qa-executor: 5 steps
  # plan-generator: 4 steps
  # qa-plan-generator: 4 steps
  # qa-parallel: 5 steps (new in GEO-293)
  ```

**For Multi-Project Support**:
- Step templates should be loaded from `project-config.yaml` `domains.{domain}.steps` array
- Agent types should be dynamic (not hardcoded)
- Same SQL schema (agents, agent_steps, step_templates, artifacts) works for any project

**No Code Changes Required** for state.sh itself — only config.sh needs to load step templates from project-config.yaml.

### 3.3 schema-v6.sql Analysis

**What's Generic**:
- All table structures and constraints
- CHECK constraints for domain/status/agent_type
- Foreign key relationships
- Indexes for performance

**What's Project-Specific**:
- CHECK constraint values for `agents.domain`:
  ```sql
  domain TEXT NOT NULL CHECK(domain IN ('backend', 'frontend', 'designer', 'qa', 'plan-generator', 'qa-plan-generator', 'qa-parallel'))
  ```
  This is hardcoded to GeoForge3D domains.

**For Multi-Project Support**:
- Remove hardcoded domain CHECK constraint
- Allow any string domain name
- Let project-config.yaml define available domains
- Migration script to recreate agents table without CHECK

**Recommended SQL Change**:
```sql
-- Remove CHECK on domain, allow any string
ALTER TABLE agents DROP CONSTRAINT domain_check;
-- Or in SQLite (which doesn't support DROP CONSTRAINT):
-- Recreate table without CHECK, migrate data, drop old table, rename new
```

### 3.4 cleanup-agent.sh Analysis

**What's Generic**:
- Failure wrappers for state updates
- Git operations: pull, mv, commit, push
- Artifact archival pattern
- Worktree cleanup

**What's GeoForge3D-Specific**:
```bash
# Domain-specific cleanup
case "$DOMAIN" in
    backend)
        # Destroy personal deployment
        pd_slug=$(_sql "SELECT value FROM artifacts...")
        ./scripts/destroy-personal.sh "$pd_slug"
        ;;
    frontend|designer)
        # Worktree cleanup for frontend/designer
        ;;
    qa)
        # QA-specific (not shown in excerpt)
        ;;
esac
```

**For Multi-Project Support**:
- Externalize domain-specific cleanup to project-config.yaml `domains.{domain}.cleanup_script`
- cleanup-agent.sh would source and execute those scripts
- Each project defines cleanup for its own domains

---

## 4. Proposed project-config.yaml Schema

```yaml
# project-config.yaml — QA Framework Configuration (YAML)

# Basic project metadata
project:
  name: "GeoForge3D"
  description: "3D geographic model generation from real-world map data"
  root: "/Users/xiaorongli/Dev/GeoForge3D"

# Domain configuration — which domains are enabled and how to handle them
domains:
  backend:
    enabled: true
    dir: "{project.root}/product/GeoForge3D-Backend"
    
    # QA-specific configuration
    qa:
      test_suites:
        default:
          - label: "City PREVIEW"
            style: "osm2world"
            type: "PREVIEW"
            config: "city_preview-v1"
            zoom: 0.05
            address: "Times Square, New York, NY"
            filter: "height_tagged"
            timeout_seconds: 600
          
          - label: "City FULL"
            style: "osm2world"
            type: "FULL"
            config: "city_default-v1"
            zoom: 0.05
            address: "Times Square, New York, NY"
            filter: "buildings_highways"
            timeout_seconds: 1200
          
          - label: "Terrain PREVIEW"
            style: "terrain_only"
            type: "PREVIEW"
            config: "terrain_default-v1"
            zoom: 1.0
            address: "Grand Canyon, AZ"
            filter: null  # omit from JSON if null
            timeout_seconds: 600
          
          - label: "Terrain FULL"
            style: "terrain_only"
            type: "FULL"
            config: "terrain_default-v1"
            zoom: 1.0
            address: "Grand Canyon, AZ"
            filter: null
            timeout_seconds: 900

        perf:
          - label: "City PREVIEW NYC (49km²)"
            style: "osm2world"
            type: "PREVIEW"
            config: "city_preview-v1"
            zoom: 0.7
            address: "Times Square, New York, NY"
            filter: "height_tagged"
            timeout_seconds: 600
            sla_seconds: 300
          
          - label: "City PREVIEW LA (49km²)"
            style: "osm2world"
            type: "PREVIEW"
            config: "city_preview-v1"
            zoom: 0.7
            address: "Downtown Los Angeles, CA"
            filter: "height_tagged"
            timeout_seconds: 600
            sla_seconds: 300
          
          - label: "City FULL NYC (12km²)"
            style: "osm2world"
            type: "FULL"
            config: "city_default-v1"
            zoom: 0.35
            address: "Times Square, New York, NY"
            filter: "buildings_highways"
            timeout_seconds: 1200
            sla_seconds: 900
          
          - label: "Terrain FULL Grand Canyon (100km²)"
            style: "terrain_only"
            type: "FULL"
            config: "terrain_default-v1"
            zoom: 1.0
            address: "Grand Canyon, AZ"
            filter: null
            timeout_seconds: 900
            sla_seconds: 600

      # API configuration
      api:
        default_url: "https://geoforge3d-api-5csvf2blaa-uw.a.run.app"
        # optional: gcloud lookup script
        # gcloud_lookup_script: "gcloud run services describe {slug}-geoforge3d-api --region=us-west1 --project=geoforge3d --format='value(status.url)'"

      # Job submission schema
      job_schema:
        endpoint: "/v1/jobs"
        method: "POST"
        fields:
          address:
            type: "string"
            from_test_case: "address"
          product_style_id:
            type: "string"
            from_test_case: "style"
          product_size_id:
            type: "string"
            constant: "small_square"  # or from_test_case: "size"
          zoom_factor:
            type: "number"
            from_test_case: "zoom"
          job_type:
            type: "string"
            from_test_case: "type"
          config_name:
            type: "string"
            from_test_case: "config"
          filter_strategy:
            type: "string"
            from_test_case: "filter"
            omit_if_null: true  # don't include field in JSON if null
          customization:
            type: "object"
            constant:
              paletteId: "classic_monochrome"
              customColors:
                baseBoardColor: "#2E4057"
                mapColor: "#48BF84"
                textColor: "#F7B32B"

      # Job polling endpoints
      job_endpoints:
        query_by_external_id: "/v1/jobs?external_id={external_id}"
        get_status: "/v1/jobs/{job_id}"
        status_field: "status"  # JSON field containing status value
        completed_status: "completed"
        failed_status: "failed"

      # Artifact storage
      artifacts:
        bucket_template: "gs://geoforge3d-artifacts-geoforge3d/{job_id}/artifacts"
        files:
          - name: "3mf"
            path: "/final_model.3mf"
            required: true
            validation:
              file_size_min_bytes:
                terrain_preview: 51200  # > 50KB
                terrain_full: 102400    # > 100KB
                city_preview: 102400    # > 100KB
                city_full: 512000       # > 500KB
              zip_integrity: true
              model_file_path: "3D/3dmodel.model"
          
          - name: "glb"
            path: "/final_model.glb"
            required: false
            validation:
              validator_script: "shared/validators/glb_validator.py"  # relative to backend dir

      # Webhook polling
      webhook_polling:
        max_wait_seconds: 120
        initial_interval_seconds: 5
        max_interval_seconds: 15
        backoff_multiplier: 1.2

      # Download directory template
      download_dir_template: "~/Downloads/{project.name}/integration-tests/{timestamp}"

      # Onboarding section (content)
      onboarding:
        product_overview: |
          GeoForge3D generates 3D geographic models from real-world map data for 3D printing.
          
          **User flow**: Customer visits Shopify store → selects location on map → chooses size/style → places order → webhook triggers backend → 3D model generated → shipped to customer.
          
          **Two generation engines**:
          - **TouchTerrain**: terrain-only models (mountains, valleys)
          - **OSM2World**: city models with buildings from OpenStreetMap data
        
        excluded_topics:
          - "Microservice architecture details"
          - "Docker/docker-compose configuration"
          - "Terraform/infrastructure"
          - "Database schema"
        
        additional_notes: "No known open bugs as of 2026-02-16. See product/doc/{domain}/test-reports/Fixed/README.md for history."

  frontend:
    enabled: true
    dir: "{project.root}/product/GeoForge3D-Frontend"
    
    qa:
      store_config:
        url: "https://geoforge3d.myshopify.com"
        password: "ratwah"
        product_page: "https://geoforge3d.myshopify.com/products/3d-custom-map-art"
        product_name: "3D Custom Map Art"
        test_email: "xrliannie.shopping@gmail.com"

      # Variants for regression testing
      product_variants:
        - size: "4\"x5\""
          variant_id: "47635229769960"
          sku: "citymap-xs"
        
        - size: "8\"x10\""
          variant_id: "47452925559016"
          sku: "citymap-small"
        
        - size: "12\"x15\""
          variant_id: "47452925591784"
          sku: "citymap-medium"
        
        - size: "16\"x20\""
          variant_id: "47452925624552"
          sku: "citymap-large"

      # Product sizes and frames
      product_sizes: ["XS", "Small", "Medium", "Large"]
      product_frames: ["None", "Black", "White", "Natural", "Walnut"]

      # Test payment configuration
      test_payment:
        gateway: "Shopify Bogus Gateway"
        cards:
          - number: "1"
            result: "success"
          - number: "2"
            result: "failure"
          - number: "3"
            result: "error"
        default_expiry: "12 / 30"  # spaces around slash required
        default_cvv: "111"

      # Playwright workarounds
      playwright_workarounds:
        - issue: "Mapbox breaks browser_snapshot"
          workaround: "Use browser_evaluate to query DOM state instead"
        
        - issue: "React 18 controlled inputs ignore synthetic events"
          workaround: "Use simulated property: Object.defineProperty(event, 'simulated', { value: true })"
        
        - issue: "Checkout PCI iframes timeout with frameLocator"
          workaround: "Use page.frame({name}) + frame.evaluate() to interact with PCI fields"
        
        - issue: "Shopify forms with React controlled components"
          workaround: "Use keyboard-based input: page.keyboard.type(value, {delay: 30})"

      # UI element selectors (framework-specific)
      ui_selectors:
        search_input: 'input[placeholder="Enter address, city, or ZIP code"]'
        color_palette_tab: 'button[data-tab="labels"]'
        preview_container: '.preview-container,[class*="preview"]'
        preview_3d_viewer: 'div[role="img"][aria-label*="3D preview"]'
        preview_error: '.text-red-500'

      # Preview generator configuration
      preview_generator:
        polling_interval_seconds: 2
        timeout_seconds: 180
        success_selectors:
          - 'div[role="img"] canvas'  # Canvas element inside preview div
        error_selectors:
          - '.text-red-500'

      # Known bugs for regression testing
      known_bugs:
        - id: 1
          title: "Reverse geocoding HTTP 422"
          description: "Use current position showed 'CURRENT LOCATION / UNKNOWN'"
          fixed_date: "2026-02-12"
          regression_selector: 'input[placeholder="Enter address..."]'
          severity: "HIGH"
        
        - id: 2
          title: "Size selection changed preview dimensions"
          description: "Changing product size resized the preview (402-482px)"
          fixed_date: "2026-02-12"
          regression_selector: '.preview-container'
          severity: "HIGH"
        
        - id: 4
          title: "Cart count badge never updates"
          description: "After add-to-cart, cart icon count doesn't increment"
          fixed_date: "v1.2.3 (PR #18)"
          regression_selector: '.cart-badge'
          severity: "HIGH"

      # Screenshot management
      screenshot_dir_template: "/Users/xiaorongli/Dev/{project.name}/test-screenshots"
      screenshot_cleanup_on_pass: true  # delete if no CRITICAL/HIGH issues

      # Test report location
      test_report_dir: "{project.root}/product/doc/frontend/test-reports"

      # E2E-specific configuration
      e2e:
        shopify_admin_api_version: "2024-10"
        shopify_admin_api_token_env: "SHOPIFY_ADMIN_API_TOKEN"
        order_confirmation_selector: |
          .os-order-number or [class*="order-number"] or (body innerText match /#\d+/)
        
        webhook_fields:
          - "_Style"
          - "_Config Name"
          - "_Bounding Box"
          - "_sizeId"
          - "_paletteId"
          - "_labels"
          - "Address"

  qa:
    enabled: true
    doc_path: "{project.root}/product/doc/qa"
    
    # QA Parallel configuration
    parallel:
      enabled: true
      max_concurrent: 1
      max_attempts: 3

# Orchestrator configuration
orchestrator:
  db_path: "{project.root}/.claude/orchestrator/agent-state.db"
  lock_dir: "{project.root}/.claude/orchestrator/locks"
  worktree_base: "{project.root}/worktrees"
  
  limits:
    max_concurrent_agents: 4
    env_lease_timeout_seconds: 1800
    docs_lock_timeout_seconds: 120
    reconcile_interval_seconds: 300
  
  # Domain watch paths (generated dynamically)
  watch_paths: "{domains[*].plan_new_path}"  # Generated from domains config

# Version management
version:
  file: "{project.root}/product/doc/VERSION"
  initial: "v3.0.0"

# Report paths and archival
reporting:
  base_path: "{project.root}/product/doc"
  plan_lifecycle: ["new", "inprogress", "archived"]
  doc_types: ["exploration", "research", "plan"]
  
  archival:
    enabled: true
    on_ship: true  # archive when agent ships
    git_commit_template: "docs: archive research docs after {geo_id} ship"
```

**Key Design Decisions**:
1. **Nested structure** for domains and qa-specific config (allows future extension)
2. **Template variables** (`{project.name}`, `{timestamp}`) for dynamic paths
3. **Parameterized test suites** instead of hardcoded tables
4. **Optional fields** (`omit_if_null`, `required: false`) for project variation
5. **String constants** for flexibility (e.g., `result: "success"` instead of enum)

---

## 5. Flywheel's Own QA Needs

### 5.1 Flywheel Bridge API Routes

Flywheel is a monorepo orchestrator with these packages:
- `core`: Base types and orchestration logic
- `teamlead`: Lead runtime with bridge API
- `terminal-mcp`: Terminal MCP server
- `edge-worker`: Cloud functions
- `github-event-transport`: GitHub webhook handling
- `slack-event-transport`: Slack integration
- Other: DAG resolver, config, runners, etc.

**Bridge API** (in `packages/teamlead/src/bridge/`):
- Routes are defined in individual TypeScript files (not a central router)
- Examples found:
  - `thread-validator.ts`
  - `bootstrap-generator.ts`
  - `post-merge.ts`
  - `publish-html-route.ts`
  - `memory-route.ts`

No full REST API spec found yet, but structure suggests bridge uses HTTP/MCP for agent communication.

### 5.2 What a "backend-test" Skill Would Look Like for Flywheel

Flywheel itself is a Node.js/TypeScript monorepo. Potential tests:

```markdown
# Flywheel Backend Integration Test

## Configuration
- Node version: 18+ (check package.json)
- Package manager: npm or yarn
- Workspaces: monorepo with `packages/*`

## Step 1: Pre-flight
```bash
cd {project.root}
npm ci
npm run build
```

## Step 2: Test Suites
| # | Suite | Target | Command | Timeout |
|---|-------|--------|---------|---------|
| 1 | Unit Tests | core | npm test --workspace=@flywheel/core | 30s |
| 2 | Unit Tests | teamlead | npm test --workspace=@flywheel/teamlead | 30s |
| 3 | Type Check | All | npm run type-check | 30s |
| 4 | Lint | All | npm run lint | 30s |
| 5 | Integration | teamlead + core | npm test --integration | 60s |

## Step 3: Execute Tests
For each test suite:
3a. Run test command
3b. Parse output (JSON or TAP format)
3c. Record pass/fail, duration, error message

## Step 4: Artifact Validation
- Coverage reports: check coverage threshold > 80%
- Type errors: zero type errors from tsc
- Lint errors: zero errors from eslint

## Step 5: Report
Print summary table with pass/fail for each suite
```

---

## 6. Additional QA-Related Files in GeoForge3D

Files found in exploration:

| File | Purpose | Hardcoded to GeoForge3D? |
|------|---------|--------------------------|
| `.claude/agents/qa-executor.md` | v1 agent (simpler, single run) | Yes (product/doc/qa/test-reports/New) |
| `.claude/agents/qa-plan-generator-executor.md` | Generates fix plans from QA failures | Yes (domains backend/frontend) |
| `.claude/skills/onboard-qa/SKILL.md` | QA onboarding | Yes (Shopify store, product sizes) |
| `.claude/skills/backend-integration-test/SKILL.md` | Backend test execution | Yes (GEO-specific API, GCS, 3MF) |
| `.claude/skills/frontend-integration-test/SKILL.md` | Frontend UI testing | Yes (Shopify, Mapbox, React) |
| `.claude/skills/e2e-integration-test/SKILL.md` | Full-chain testing | Yes (Shopify checkout, webhook) |
| `.claude/domains/qa.md` | QA domain knowledge | Yes (GeoForge3D product) |

---

## 7. Extraction Plan

### 7.1 What to Copy Verbatim
1. **state.sh** — No changes needed, fully generic
2. **lock.sh** — No changes needed, fully generic
3. **schema-v6.sql** (with migration) — Needs domain CHECK removal but logic is generic
4. **Execution flow logic** from qa-parallel-executor.md — Fully reusable, just skip GeoForge3D-specific paths

### 7.2 What to Rewrite
1. **config.sh** — Add project-config.yaml loading
2. **cleanup-agent.sh** — Externalize domain-specific cleanup to config
3. **qa-parallel-executor.md** — Parameterize all hardcoded paths, refactor for project-agnostic language
4. **Skill files** — Create templates/samples with placeholder sections

### 7.3 What to Parameterize
1. All paths: PROJECT_ROOT, BACKEND_DIR, FRONTEND_DIR, OpenAPI spec, GCS bucket, download directories
2. Test suites: Move table data to project-config.yaml
3. API endpoints: Templatize URL, authentication, request/response schema
4. Shopify configuration: Store URL, credentials, product variants, test cards
5. Playwright workarounds: List by framework/library name
6. UI selectors: Map component name to CSS selector
7. Validation thresholds: File sizes, timeout values, SLA values
8. Document paths: Where to store specs, research, reports

### 7.4 What to Create New
1. **project-config.yaml** — YAML schema (see Section 4)
2. **project-config.ts** (optional) — TypeScript types/validation for config
3. **skill-registry.ts** — System to discover/validate skills available in a project
4. **qa-framework/** package structure:
   ```
   packages/qa-framework/
   ├── src/
   │   ├── config/
   │   │   ├── schema.ts          # Zod/ajv schema for project-config.yaml
   │   │   └── loader.ts          # Load and validate YAML
   │   ├── orchestrator/
   │   │   ├── config.sh          # Refactored with config loading
   │   │   ├── state.sh           # Copied verbatim
   │   │   ├── cleanup-agent.sh   # Refactored
   │   │   └── migrations/        # SQL migrations
   │   ├── agents/
   │   │   ├── qa-parallel-executor.md  # Templatized
   │   │   └── ...other agents
   │   ├── skills/
   │   │   ├── onboard-qa-template/
   │   │   ├── backend-integration-test-template/
   │   │   ├── ...
   │   │   └── SKILL_INTERFACE.md  # Contract all skills must follow
   │   └── README.md
   ├── examples/
   │   ├── geoforge3d/
   │   │   └── project-config.yaml  # Working example
   │   └── flywheel/
   │       └── project-config.yaml  # Minimal example for Flywheel
   ├── tests/
   │   ├── config.test.ts
   │   ├── orchestrator.test.sh
   │   └── ...
   └── package.json
   ```

### 7.5 Implementation Order
1. **Phase 1 — Foundation**
   - Create qa-framework package structure
   - Write project-config.yaml schema
   - Refactor config.sh to load YAML

2. **Phase 2 — Orchestrator**
   - Copy state.sh, lock.sh, schema-v6.sql
   - Refactor cleanup-agent.sh
   - Write SQL migrations

3. **Phase 3 — Agents**
   - Templatize qa-parallel-executor.md
   - Parameterize all paths and hardcoded values

4. **Phase 4 — Skills**
   - Create skill templates/samples
   - Write SKILL_INTERFACE.md documentation
   - Migrate GeoForge3D skills as examples

5. **Phase 5 — Integration**
   - Test with GeoForge3D config
   - Test with Flywheel minimal config
   - Create migration guide for existing projects

---

## 8. Risk Assessment

### 8.1 High-Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Skills are highly coupled to project internals** | Can't reuse a skill for different projects without refactoring | Create skill templates with clear customization points. Document what varies by project. Provide examples. |
| **Hardcoded Shopify/GCS/gcloud credentials** | Framework leaks project secrets | Move all credentials to environment variables (SHOPIFY_ADMIN_API_TOKEN, GCP_PROJECT, etc.). Never include in project-config.yaml. |
| **OpenAPI spec location varies** | Can't assume spec exists or has same schema | Make spec path configurable. Gracefully skip API contract tests if spec missing. Log warnings, not failures. |
| **Test environment availability** | Tests fail if backend/frontend not running or deployed | Make environment pre-checks part of onboarding. Allow per-test environment overrides. |
| **SQLite database locks on concurrent writes** | Orchestrator becomes bottleneck if multiple agents try to update state simultaneously | State tracking already has retry logic (3 retries with exponential backoff). Schema has transaction support. May need distributed coordination if scaling to 10+ concurrent agents. |
| **Artifact bucket paths change per project** | Downloads fail, artifacts not found | Make bucket template configurable. Require projects to document their artifact storage structure. |

### 8.2 Medium-Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Project file structure is unpredictable** | Can't reliably find source code, test files, docs | Define a standard directory structure in documentation. Make paths configurable in project-config.yaml. Provide linter to validate structure. |
| **Skill discovery is manual (hardcoded in agent definitions)** | Easy to forget to list a skill | Create skill registry that scans `.claude/skills/` and validates against project-config.yaml. |
| **Document archival relies on git mv** | Fails if git branch is dirty or remotes diverge | Already has guards (check for uncommitted changes, pull --ff-only). May need to improve error recovery. |
| **CI/CD integration unknown** | Framework may not work in GitHub Actions or CI environment | Document CI assumptions. Test in CI early. |

### 8.3 Low-Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Version bump race conditions** | Multiple QPGs bump version at same time | Lock mechanism already in place (acquire_lock with 30s timeout and stale reclaim). |
| **Screenshot directory cleanup** | Stray .png files accumulate | Already cleans up after each test. Document cleanup procedure. |
| **Report naming conflicts** | Timestamp collision overwrites report | Timestamp uses YYYY-MM-DD-HHMMSS (1-second resolution). UUID fallback if needed. |

### 8.4 Breaking Changes & Migration

Extracting to qa-framework WILL require:

1. **GeoForge3D must create project-config.yaml** (or copy from qa-framework/examples/geoforge3d/)
2. **All hardcoded paths in agents must be removed** and replaced with config lookups
3. **Skill files need documentation** about customization points
4. **config.sh must support both old (hardcoded) and new (YAML-based) modes** for backward compatibility during transition
5. **Testing & rollback plan** needed before deploying to production orchestrator

---

## 9. Recommended Next Steps

### 9.1 Quick Win: Skill Templates Only (Week 1)
- Document generic parts of each skill (methodology)
- Create SKILL_INTERFACE.md with customization contract
- Add comments to GeoForge3D skills marking what's generic vs. hardcoded
- No code changes yet — just documentation

### 9.2 Foundation: Config Schema (Week 2)
- Design project-config.yaml schema (see Section 4)
- Implement YAML loader in TypeScript
- Test schema validation with GeoForge3D config
- Create schema documentation for project authors

### 9.3 Core: Orchestrator Refactoring (Week 3-4)
- Refactor config.sh to load from YAML
- Update cleanup-agent.sh for domain-specific extensibility
- Migrate SQL schema (remove domain CHECK constraint)
- Test state tracking with new config system

### 9.4 Integration: Package Creation (Week 5)
- Create packages/qa-framework with structure from Section 7.4
- Copy/refactor orchestrator scripts
- Templatize agent definitions
- Create skill samples/templates

### 9.5 Launch: Testing & Documentation (Week 6)
- Test with GeoForge3D existing orchestrator
- Test with minimal Flywheel example
- Create migration guide for existing projects
- Write comprehensive README

---

## 10. Detailed Findings by Research Question

### Q1: QA Agent Protocol — What's truly generic vs hardcoded?

**Answer**: The 5-step flow is fully generic. ~40% of the code (state tracking, step templates, error handling) is reusable. The remaining 60% consists of:
- Hardcoded path lookups (PROJECT_ROOT, BACKEND_DIR, etc.)
- Hardcoded test suites (table of test cases)
- Hardcoded domain names (backend, frontend, qa, plan-generator, qa-plan-generator, qa-parallel)
- Project-specific onboarding content (Shopify store config, test cards)

**How it references skills**: By name only (`Skill(skill="onboard-qa")`), with a fallback Read() mechanism. Skills are explicitly listed in agent definitions, not auto-discovered.

### Q2: Sample Skills — What's the generic core?

**Answer**: Each skill has a clear generic methodology:

- **onboard-qa**: Generic structure is "read product context, verify test commands available, review known issues". Project-specific content is the product description, store config, and known bugs list.

- **backend-integration-test**: Generic structure is "resolve API URL, run test suite, download artifacts, validate files, report summary". Project-specific content is the test cases, artifact bucket, validation thresholds, and API request/response schema.

- **frontend-integration-test**: Generic structure is "navigate UI steps, capture screenshots, track issues by severity, generate report". Project-specific content is the Shopify config, product options, UI selectors, and known bugs.

- **e2e-integration-test**: Generic structure is "execute frontend checkout, query order API, track backend job, validate artifact, report". Project-specific content is Shopify details, order API structure, job status endpoints.

**Useful samples** would parameterize all project-specific content and document customization points clearly.

### Q3: Orchestrator — What needs to change?

**Answer**:

- **config.sh**: Add YAML loader to read project-config.yaml and set variables dynamically
- **state.sh**: No changes needed (fully generic)
- **schema-v6.sql**: Remove hardcoded CHECK constraints on domain values
- **cleanup-agent.sh**: Externalize domain-specific cleanup to project-config.yaml

### Q4: project-config.yaml Schema

**Answer**: See Section 4 for the detailed schema. Key sections:
- `project`: Metadata and root path
- `domains.{domain}.qa`: Test suites, API config, artifact storage, validation rules
- `domains.{domain}.frontend.qa`: Shopify config, UI selectors, known bugs
- `orchestrator`: DB path, limits, watch paths
- `version`: Version file location

### Q5: Flywheel's own QA needs

**Answer**: Flywheel is a Node.js/TypeScript monorepo. Its QA needs are simpler than GeoForge3D (no 3D model generation, no complex UI):

**Potential test suites**:
- Unit tests per package (npm test --workspace=@flywheel/core)
- Type checking (tsc --noEmit)
- Linting (eslint)
- Integration tests (multi-package workflows)
- Coverage validation (> 80%)

**A backend-test skill for Flywheel** would run npm test commands and validate coverage/type/lint results.

### Q6: Additional QA files

**Answer**: Found agents for v1 (qa-executor), fix plan generation (qa-plan-generator-executor), and domain knowledge docs (qa.md). All are heavily customized to GeoForge3D and would need similar parameterization as the v2 parallel agent.

---

## Appendix: File Size & Token Summary

| File | Lines | Hardcoded References |
|------|-------|----------------------|
| qa-parallel-executor.md | 535 | PROJECT_ROOT, product/doc/qa/*, step naming |
| qa-executor.md | 344 | product/doc/qa/*, test allowlist, gcloud auth |
| qa-plan-generator-executor.md | 231 | product/doc/{domain}/plan/*, VERSION file |
| onboard-qa/SKILL.md | 124 | Shopify store, test cards, known bugs, variants |
| backend-integration-test/SKILL.md | 310 | API URLs, GCS bucket, 3MF validation, test suites |
| frontend-integration-test/SKILL.md | 710 | Shopify store, product options, Playwright workarounds, known bugs |
| e2e-integration-test/SKILL.md | 542 | Shopify API, webhook polling, order confirmation selector |
| config.sh | 111 | PROJECT_ROOT, all paths, version bump logic |
| state.sh | 1000+ | Step templates (executor, designer, qa-executor, plan-generator, qa-plan-generator) |
| schema-v6.sql | 61 | domain/status/agent_type CHECK constraints |
| cleanup-agent.sh | 200+ | Domain-specific cleanup (backend: destroy PD; frontend: worktree cleanup) |

**Total extractable code**: ~3500 lines (skills + agents + orchestrator)
**Total parameterizable values**: ~150 (paths, URLs, test suites, selectors, credentials)

---

## Conclusion

Extracting GeoForge3D's QA Agent v2 into a reusable framework is **feasible but non-trivial**. The generic orchestration core (~40%) can be moved to `packages/qa-framework` with minimal changes. The remaining 60% requires comprehensive parameterization via project-config.yaml.

**Effort estimate**: 6-8 weeks for a production-ready framework (design, implementation, testing, documentation, migration).

**Key success factors**:
1. Clear project-config.yaml schema covering all parameterizable values
2. Skill templates with explicit customization contract (SKILL_INTERFACE.md)
3. Comprehensive documentation of what varies by project
4. Working examples (GeoForge3D + Flywheel)
5. Migration tooling for existing projects

