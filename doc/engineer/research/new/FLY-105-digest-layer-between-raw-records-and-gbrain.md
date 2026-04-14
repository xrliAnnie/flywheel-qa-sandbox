# Research: Digest Layer Between Raw Records and GBrain — FLY-105

**Issue**: FLY-105
**Date**: 2026-04-13
**Source**: `doc/engineer/plan/inprogress/v1.23.0-FLY-90-gbrain-wiki-deployment.md`, gbrain source analysis, Myco source analysis, Flywheel knowledge workflow review
**Status**: Complete

---

## 1. Research Question

Flywheel already records a large amount of potentially valuable project knowledge:

- plans
- retros
- research docs
- QA reports
- session transcripts
- operational notes
- shared rules and conventions

The open question is not whether Flywheel has enough recorded material. It does.

The real question is:

**How should Flywheel turn raw recorded material into reusable shared project knowledge without polluting the wiki layer with noise?**

This research evaluates:

1. whether gbrain alone is sufficient
2. what Myco adds conceptually
3. whether Flywheel should introduce a digest layer between raw records and gbrain

## 2. Key Conclusion

### 2.1 Short version

- **gbrain should remain the shared wiki / shared project brain**
- **Flywheel still lacks a true digest layer**
- **Myco is most useful as a source of digest / learning-loop ideas, not as a full replacement framework**

The missing capability is:

```text
raw records -> digest candidate -> review -> curated wiki knowledge -> better future agent behavior
```

### 2.2 Why this matters

If Flywheel only indexes raw material directly into gbrain, retrieval quality may be constrained by:

- duplicated conclusions across docs
- stale historical context
- too much low-signal detail
- raw transcripts that are searchable but not yet distilled into reusable truth

That means Flywheel may end up with a better search layer, but not necessarily a better learning system.

## 3. What gbrain Actually Does

### 3.1 Important correction

gbrain is **not** just a vector database.

Its storage model separates:

- **human-readable page content**
- **structured timeline/history/raw data**
- **embedding-backed retrieval index**

From gbrain's schema:

- `pages` stores the core page content (`title`, `compiled_truth`, `timeline`, `frontmatter`)
- `content_chunks` stores chunked content plus embeddings
- `timeline_entries` stores structured evidence entries
- `page_versions` stores snapshots
- `raw_data` stores sidecar JSON from external systems

This means a human can review what is actually stored in the knowledge system.

### 3.2 Why gbrain is still useful

gbrain is strong at:

- shared project wiki pages
- structured read/write loops for agents
- hybrid retrieval
- timeline-backed knowledge evolution
- versioned page updates

That makes it a strong **L2 shared knowledge layer** for Flywheel.

### 3.3 gbrain's main limitation for Flywheel

gbrain does not inherently solve:

- what raw records are worth promoting
- how to detect recurring lessons from transcripts
- how to merge duplicate lessons across retros/research/QA
- how to prevent raw material from becoming noisy wiki content

In other words:

- gbrain is a good **knowledge store + retrieval layer**
- it is not automatically a good **knowledge metabolism layer**

## 4. What Myco Adds

### 4.1 Core idea

Myco is not mainly a search system.

Its core value is that it treats project knowledge as a living system that must be:

- ingested
- digested
- condensed
- checked for health
- pruned
- evolved

That is much closer to Flywheel's current gap.

### 4.2 What seems most relevant to Flywheel

The most transferable ideas from Myco are:

1. **Digest**
   Turn raw records into reusable patterns, decisions, and lessons.

2. **Immune checks**
   Detect drift, stale docs, broken rules, contradictory knowledge, and weak documentation hygiene.

3. **Transcript indexing**
   Treat session transcripts as a first-class source of learnings rather than dead logs.

4. **Knowledge lifecycle**
   Distinguish raw material from curated knowledge.

### 4.3 What should not be copied wholesale

Flywheel already has its own:

- orchestration runtime
- lead/runner workflow
- doc pipeline
- memory layering
- protocol vocabulary

That means importing the full Myco worldview would likely create:

- overlapping conventions
- duplicated process layers
- higher operational complexity

So the right move is to borrow Myco's **digest ideas**, not necessarily adopt Myco's full framework.

## 5. Recommended Architecture

### 5.1 Add a digest layer in front of gbrain

Recommended pipeline:

```text
raw records
  -> signal detection
  -> digest candidate creation
  -> human or semi-automatic review
  -> promotion into gbrain
  -> future task retrieval
```

This preserves gbrain as the durable shared wiki while improving the quality of what enters it.

### 5.2 Role of each existing system

| Layer | System | Responsibility |
|------|--------|----------------|
| L1 | session context / auto memory | immediate task context |
| L2 | gbrain | shared project wiki and durable reusable knowledge |
| L3 | mem0 | private memory, preferences, short-horizon signals |
| New pre-L2 layer | digest layer | transform raw records into curated knowledge candidates |

### 5.3 Practical interpretation

Flywheel should not send every raw artifact directly into gbrain as if all records are equally valuable.

Instead:

- raw records remain available as evidence
- digest candidates extract reusable learnings
- reviewed candidates become wiki knowledge
- future agents query the curated wiki rather than re-reading everything from scratch

## 6. Proposed Minimal Digest Pipeline

The first version should be deliberately small and mostly review-driven.

### 6.1 Inputs

Start with these sources:

- retros
- selected session transcripts
- QA reports
- research docs
- implementation notes when they contain stable lessons

### 6.2 Candidate object types

Limit early digest output to a few categories:

- `decision`
- `failure-pattern`
- `workflow-lesson`
- `runbook`
- `architecture-truth`

### 6.3 Candidate schema

Each digest candidate should include at least:

- `type`
- `summary`
- `evidence`
- `source_refs`
- `scope`
- `confidence`
- `target_slug`
- `proposed_action` (`create`, `merge`, `ignore`)

This gives Flywheel a stable review object before anything is promoted to the wiki.

### 6.4 Review gate

Do not auto-promote directly into gbrain in v1.

Instead:

- generate candidate knowledge
- let a Lead or human reviewer validate it
- then write curated output into gbrain

This reduces the risk of:

- over-generalized lessons
- duplicated truths
- stale or local observations being treated as global rules

## 7. What a First Implementation Could Look Like

### 7.1 Minimal loop

```text
raw records -> candidate generator -> review queue -> gbrain writer
```

This does not require a full UI or a large standalone subsystem.

It can start as:

- one or more input directories
- one candidate output format
- a review step
- a write-to-gbrain step

### 7.2 Why UI is not the first problem

During this investigation, a possible review UI shape was sketched.

However, the main bottleneck is not visualization.
The main bottleneck is defining:

- what goes into digest
- what a digest candidate looks like
- what gets promoted
- how promotion updates gbrain pages/timelines

UI can come later.

## 8. Open Questions

These should be answered before implementation:

1. Which transcript sources are high enough quality to digest automatically?
2. Should digest candidates live inside the Flywheel repo, a sidecar repo, or a dedicated local store?
3. Should promotion primarily create new pages, append timelines, or rewrite compiled truth on existing pages?
4. What review threshold is required before a candidate becomes shared knowledge?
5. Which category should be piloted first: `failure-pattern` or `workflow-lesson`?

## 9. Recommendation

### 9.1 Immediate recommendation

Do **not** replace the current gbrain direction.

Instead:

1. keep gbrain as the shared wiki
2. add a digest concept in front of it
3. borrow digest/immune/lifecycle ideas from Myco
4. validate the first loop on a narrow class of records

### 9.2 Best first pilot

The best first pilot is likely:

```text
selected transcript or retro
  -> failure-pattern / workflow-lesson candidate
  -> review
  -> gbrain page or timeline update
```

This is small enough to test quickly and valuable enough to show whether digest improves over raw retrieval.

## 10. Final Position

Flywheel's knowledge problem is no longer "how do we store more?"

It is:

**How do we convert what Flywheel already records into durable, reviewable, reusable knowledge that makes future agents meaningfully smarter?**

That is why the right strategic combination is:

- **gbrain for shared wiki**
- **Myco-inspired digest concepts for knowledge metabolism**
- **Flywheel as the orchestration and behavior layer**
