---
version: "003"
date: 2026-02-25
topic: "Decision Layer Deep Research — Gemini Pro Results"
parent: "doc/engineer/research/new/002-research-gaps-supplement.md"
source: "Gemini Pro Deep Research"
status: draft
note: "Original research targets Discord; we've since switched to Slack. Concepts identical."
---

# Decision Layer Deep Research — Gemini Pro Results

## Executive Summary

To transition Flywheel from a manual orchestrator to an autonomous "Head of Product" without exploding token costs, the Decision Layer should act as an embedded **Retrieval-Augmented Preference Learning** engine. Instead of brittle and expensive model fine-tuning, implement the **PRELUDE/CIPHER** framework (NeurIPS 2024), which uses a low-cost LLM (Haiku) to translate manual choices into explicit, natural-language "preference rules." Store these rules locally using SQLite + `sqlite-vec`, retrieve them when new ambiguities arise, and combine deterministic hard rules with a dual-gate probabilistic confidence score.

## 1. Progressive Autonomy — Existing Approaches

Production AI systems graduate from Human-In-The-Loop (HITL) to Human-Out-Of-The-Loop (HOOTL) using bounded domains and confidence thresholds.

- **"Management by Exception"**: AI calculates risk-adjusted confidence. High-frequency/low-risk (test failure triage) → threshold 75%. High-risk (DB schema change) → threshold 99% or explicitly forbidden.

### Failure Modes

| Failure Mode | Description |
|-------------|-------------|
| **Automation Bias** | AI is usually right → CEO blindly clicks "Approve" → catastrophic error missed |
| **Concept Drift** | CEO switches patterns (OOP → Functional), system confidently applies old preferences |
| **False Confidence** | LLMs overestimate certainty on novel edge cases |

## 2. Decision Pattern Learning — Technical Approaches

### CIPHER (NeurIPS 2024, Gao et al.)

State-of-the-art for this exact problem. Instead of passing raw decision logs to LLM, CIPHER looks at the *delta* between AI's proposal and human's edit, inferring a **latent natural language preference** (e.g., *"User prefers explicit type-casting over 'any' in utility functions"*).

**Limitation**: Assumes static preferences → implement time-decay or manual invalidation.

### Few-Shot RAG vs Fine-Tuning → **Use RAG**

Fine-tuning is expensive, slow to iterate, suffers from catastrophic forgetting. RAG allows instant "deletion" of a bad habit from the database.

### Similarity Computation

Use semantic embeddings on composite string: `[Category] + [Context Summary]`. Use `Xenova/all-MiniLM-L6-v2` via `transformers.js` natively in TypeScript (**zero API cost**).

### Confidence Scoring — Dual-Gate Threshold

Do NOT rely on LLM token probabilities. Use:

1. **Vector Distance**: If Cosine Distance to nearest historical rule > 0.35 → novel situation → **Escalate**
2. **Prompted Evaluation**: If distance < 0.35, pass retrieved rules to Haiku → output `confidence_score` (1-100). Auto-decide only if `score > 85`.

## 3. Decision Taxonomy & Schema Design

### Taxonomy

`SCOPE_ADJUSTMENT`, `ARCHITECTURE_CHOICE`, `ERROR_TRIAGE`, `DEPENDENCY_RESOLUTION`, `PR_APPROVAL`

### Schema (SQLite / better-sqlite3)

```typescript
interface DecisionRecord {
  id: string;
  timestamp: number;
  project_id: string;
  category: DecisionCategory;
  context_summary: string;     // Haiku's 2-sentence summary
  ai_proposal: string;
  human_choice: string;        // What CEO actually clicked
  inferred_rule: string;       // Generated post-decision via CIPHER
  embedding: Float32Array;     // Vector of the inferred_rule
  outcome: 'SUCCESS' | 'REVERTED'; // Used for RLHF-style penalty
}
```

### Detecting Landscape Changes

Hash `package.json` dependencies. If major framework version changes → automatically lower confidence threshold by 30% for that project to force re-learning.

## 4. Summarization & Context Presentation

Raw AI agent dumps are unreadable on mobile. Decision Layer must act as analyst presenting executive brief.

### Summarization Approach

Feed last 50 lines of Claude Code's `stdout`/`stderr` + `git diff` to Haiku. Prompt output:
1. The Blocker
2. Options (1-line pros/cons each)
3. Recommendation

### Presentation (Slack adaptation)

- Color-coded blocks (Red = Triage, Blue = Architecture)
- Screenshots via Playwright for UI test failures
- Interactive buttons: `[Option A]` `[Option B]` `[Reject/Thread]`

### Batching Digests

Queue non-urgent decisions (e.g., `DEPENDENCY_RESOLUTION`) in SQLite. Cron job at configurable interval → Haiku groups logically → single Slack message: *"Digest: 4 routine decisions pending. [Approve All] [Review Individually]"*

## 5. Safety & Override Mechanisms

### Hard Rules (Deterministic Guardrails) — Run BEFORE LLM

```typescript
if (files.some(f => f.includes('/auth') || f.includes('/billing')))
  return ESCALATE;
```

### The "Undo" Override

When Phase 2/3 auto-executes, post FYI to Slack: *"🤖 Auto-Merged PR #42 (Confidence 91%)."* Attach **[⏪ Revert]** button.

Clicking "Revert" → `git revert` in orchestrator + update SQLite `outcome` to `REVERTED` + generate **Negative Constraint Rule** (e.g., *"Never auto-merge if test coverage drops, even if tests pass"*).

### Audit Trail

Append-only JSONL log tracing exactly which retrieved rule caused each auto-decision.

## 6. Architecture & Implementation

### Architecture: Embedded, Not Microservice

Solo dev → do not build separate service. Create `DecisionManager` class in orchestrator codebase.

### LLM Model

**Haiku** for classification + summarization. Save Sonnet tokens for actual coding agent.

### Storage

`better-sqlite3` + `sqlite-vec` (modern, dependency-free C-extension for vector search). Store relational decision metadata AND vector embeddings in single local `.sqlite` file.

### Cost Estimate

Haiku + local transformers.js embeddings: ~2,000 tokens per decision = **~$0.0005 per decision**. 2,000 decisions for $1.00.

## 7. Competitive Analysis

| Product | Decision Handling | Learns Preferences? |
|---------|------------------|-------------------|
| **Cyrus** | Linear comments for async approvals | ❌ No |
| **GitHub Copilot Workspace** | Rigid hooks + human checkpoints | ❌ No |
| **Devin / Factory.ai** | Objective verification (linters, tests) | ❌ No (hardcoded loops) |
| **Vercel v0 / Bolt.new** | Synchronous chat, halt at ambiguity | ❌ No |
| **Flywheel (ours)** | Progressive autonomy + CIPHER learning | ✅ Yes |

**Key differentiator**: None of the existing tools learn CEO's architectural style across sessions. They all treat the human as an un-bypassable gate.

## 8. Recommended Build Order

### Phase 1: Observer (Week 1-2)
1. `better-sqlite3` + Slack integration in orchestrator
2. Intercept Claude Code pauses/stdout → Haiku → summarized Slack message with buttons
3. Save raw interaction to SQLite on button click

### Phase 1.5: Learner (Week 3)
1. `sqlite-vec` + `@xenova/transformers`
2. CIPHER engine: async background job after every manual decision → Haiku extracts "Preference Rule"
3. Generate local embedding → save to `sqlite-vec` table

### Phase 2: Advisor (Week 4-5)
1. RAG pipeline: new decision → `sqlite-vec` query top 3 similar rules
2. Pass rules to Haiku → `confidence_score`
3. If confidence < 85 → Slack: *"I lean towards Option A based on past rules (Confidence 72%), but need approval."*

### Phase 3: Head of Product (Week 6+)
1. 85% threshold for auto-execution + TypeScript Hard Rules
2. `[⏪ Revert]` button workflow for negative reinforcement
3. Local cron for Daily Batch Digest

## 9. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| **Silent Cascading Fails** (auto-decision breaks build, agent tries to fix, burns tokens) | Max Turns Counter per issue. >3 Decision Layer invocations/hour for same issue → hard escalate + halt DAG |
| **Context Window Bloat** (raw terminal output too massive for Haiku) | Deterministic truncation: last 50 lines stderr/stdout + `git diff --stat` only |
| **"Yes Man" Drift** (learns bad habit from CEO rushing) | Time Decay: penalty on vector distance for rules > 60 days old. Auto-approvals rely on recent, validated behaviors |

## Sources

- [PRELUDE/CIPHER — NeurIPS 2024](https://arxiv.org/abs/2404.15269)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [Cyrus](https://github.com/ceedaragents/cyrus)
