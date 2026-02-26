# Decision Layer for a TypeScript AI Dev Orchestrator

A practical Decision Layer for your autonomous dev orchestrator should be designed as **selective autonomy with an abstain path**: it learns from your historical outcomes, but it only auto-acts inside clearly bounded “operational design domains” (ODDs) that you can define and evolve—similar in spirit to how autonomy is staged in safety-critical domains (e.g., *levels of automation* and *sliding/adjustable autonomy*). citeturn0search24turn2search12turn0search2 The most robust path for a solo developer is to start with **event-sourced decision logging** (complete audit + replay), then layer in **deterministic gates** (tests/CI, protected branches, sensitive-path rules) and **case-based retrieval** (embeddings + structured features) before you consider any fine-tuning. citeturn9search1turn2search2turn10search3turn10search0 You can implement confidence as **calibrated selective classification** (“predict or abstain”), optionally strengthened with conformal-style risk control on top of your own logged outcomes, so the system learns when to auto-decide vs. escalate. citeturn0search11turn0search31turn0search3 For your Discord-first UI, treat each escalation like a well-designed bot-to-human handoff: preserve context, summarize evidence, present options + recommendation, and always allow an explicit human override—because automation bias and “false confidence” are predictable failure modes whenever humans supervise machine suggestions. citeturn1search24turn2search1turn2search29turn7search0

## Key Findings per Topic

**1) Existing approaches to progressive autonomy in AI systems**

Progressive autonomy in production systems typically evolves by (a) **defining responsibility boundaries**, (b) **instrumenting outcomes**, and (c) **graduating authority only in constrained contexts**. This mirrors how driving automation is defined as levels with explicit division of responsibility between the human driver and automation (e.g., SAE level taxonomy), and how broader human–automation models treat “what is automated” (information acquisition/analysis/decision/action) as separable dimensions that can be raised gradually. citeturn0search24turn2search12turn2search4

A mature pattern is “**sliding/adjustable autonomy**”: the system dynamically changes autonomy level based on task difficulty, uncertainty, and operational constraints, rather than flipping from manual → full auto. In robotics and human–autonomy teaming literature, sliding autonomy is repeatedly used to manage edge cases by handing control back to humans when conditions exceed the autonomy envelope. citeturn0search2turn0search22turn0search29 That concept maps cleanly onto a dev orchestrator: your Decision Layer should define an ODD per decision type (e.g., “merge trivial PRs only if X, Y, Z”), then expand the ODD as you accumulate evidence.

Cross-domain examples that translate well to your workflow:

- **Customer-service bots:** Production guidance commonly emphasizes *confidence thresholds*, *handoff triggers*, and *context preservation* so customers don’t repeat themselves. These are directly analogous to your Discord escalations (thresholds for escalation, plus a “handoff packet” that includes the relevant evidence and a summary). citeturn1search24turn2search11turn2search7turn1search28  
- **Trading / automated risk systems:** Regulators and industry guidance emphasize robust supervision and controls (e.g., supervisory systems, pre-trade risk controls, and “kill switches”) because failure can be fast and catastrophic. Even though your domain is software, the same logic applies: irreversible actions (merge to main, deploy, rotate secrets) need stronger gates and explicit rollback plans. citeturn1search1turn1search21turn1search5turn1search25  
- **AI-assisted code review / governance:** In software delivery, autonomy is commonly restricted using *branch protections*, *required status checks*, and *required reviews*. These are valuable precisely because they act as independent safety rails outside the agent’s reasoning. citeturn2search2turn12search9turn12search1  
- **Human-centered automation design:** Human–automation guidance repeatedly stresses that humans must remain in command with systems that are predictable, transparent, and overrideable (and that “human oversight” is not a magic safety guarantee by itself). That aligns with your need for explicit override flow + auditing. citeturn0search5turn2search21turn1search15

Key failure modes to plan for early:

- **False confidence / plausible wrongness:** Systems can present incorrect conclusions confidently; users can over-trust them. Human factors research shows people’s judgments can be meaningfully skewed by incorrect algorithmic support, especially when the suggestion arrives before the human forms their own view. citeturn2search1turn2search29  
- **Automation bias in “human-in-the-loop” review:** Oversight often degenerates into rubber-stamping, especially when volume rises or the tool is usually right. This is a documented risk in many HITL deployments. citeturn2search29turn2search21  
- **Edge cases + drift:** The system’s effective decision distribution changes when you switch repos, stacks, priorities, or quality bars—so escalating less over time is not monotonic; you need drift detection with “fall back to human” behavior when the landscape shifts. citeturn9search8turn9search27turn9search19

**2) Decision pattern learning — technical approaches**

A Decision Layer can be framed as a **selective decision policy**:

1) Predict an action (approve/merge/retry/escalate/etc.), **or**  
2) Abstain and escalate with a well-structured question.

This maps directly onto **selective classification** (classification with a reject/abstain option), where the goal is not maximum coverage but controlled risk on the subset you auto-handle. citeturn0search11turn0search31turn0search3

Practical representations to learn from decisions (without expensive fine-tuning):

- **Case-based memory (recommended baseline):** Store each decision as a “case” with features + outcome, then retrieve nearest neighbors for new decisions using semantic embeddings and structured filters. Sentence embeddings are a well-established way to compute semantic similarity efficiently (e.g., SBERT). citeturn10search3turn10search7  
- **Preference descriptors (LLM-generated, editable):** Inspired by PRELUDE/CIPHER, you can infer a **natural-language preference rule** (your implicit policy) from your historical choices, then retrieve/aggregate the most relevant preference snippets to guide future decisions. citeturn3search6turn3search2turn3search1  
- **Hybrid symbolic + retrieval:** Maintain (a) a hard-rule policy layer and (b) a retrieval-based learned policy. This matches “domain knowledge + data-driven” design advice for trustworthy decision support: rules handle invariants; learning handles nuance. citeturn1search7turn12search9

PRELUDE/CIPHER applicability (and limits) for your use case:

- **What PRELUDE/CIPHER is:** PRELUDE is a framework for learning a user’s latent preferences from user edits; CIPHER infers preference descriptions per context, then retrieves similar contexts and aggregates preferences to reduce future edits—explicitly trying to avoid user-specific fine-tuning. citeturn3search6turn3search2turn3search1  
- **Why it’s relevant:** Your “decisions” are preference signals. Even when you click a button (“merge” vs “request changes”), you’re expressing latent policy. A CIPHER-like layer can turn your historical decisions into **interpretable preference statements** (“I accept dependency bumps if tests pass and no lockfile churn”) and retrieve them for new situations. citeturn3search2turn3search6  
- **Key limitations to account for:** The paper’s evaluation environments are assistive writing tasks (summarization/email) and use a simulated user; your domain includes multi-step consequences (merging affects future incidents), plus hard security boundaries and codebase-specific conventions. Expect you’ll need stronger structural features and explicit safety rails than PRELUDE/CIPHER alone provides. citeturn3search2turn3search6turn2search29

Few-shot vs fine-tuning vs RAG/retrieval for Flywheel-like decisioning:

- **Few-shot prompting:** Fast to start, but can be token-expensive if you keep stuffing examples; also brittle when your “examples” need structured evidence (diffs, logs). Best used as a bootstrapping tool, not the long-term memory strategy. citeturn3search2turn13view0  
- **Fine-tuning:** Usually requires enough labeled data and evaluation discipline; and it can “bake in” outdated policies, which is risky when your preferences drift across projects. PRELUDE explicitly argues against per-user fine-tuning for scalability/cost and potential performance degradation on other tasks. citeturn3search2turn3search6  
- **Retrieval-augmented decisioning (recommended):** For a solo developer, retrieval is the sweet spot: you can keep a growing, searchable memory, and you can scope by repository/project/stack. Embeddings + vector search libraries are mature; you can even embed locally to minimize token spend. citeturn10search3turn10search2turn11search8

Similarity computation options that are implementable in a local TypeScript system:

- **Semantic embeddings:** SBERT-style embeddings are designed specifically for cosine-similarity based retrieval. citeturn10search3  
- **Local embedding generation in JS:** Transformers.js provides feature extraction/embeddings in JavaScript runtimes, and there are published examples of computing embeddings and cosine similarity in Node. citeturn11search4turn11search8turn11search5  
- **Vector indexing:** If you want “no server” local-first storage, SQLite vector extensions (e.g., sqlite-vec) provide embedded vector search, and Faiss is a canonical similarity-search library underlying many vector systems. citeturn10search0turn10search2turn10search6

Confidence scoring for “auto-decide vs escalate”:

- **Start with deterministic confidence from hard gates** (e.g., “required status checks passed” → high confidence for merge *only if code is low-risk*). Branch protections and required checks are a strong signal because they’re external, not self-reported by the model. citeturn2search2turn2search18  
- **Add a learned abstain mechanism:** Selective classification formalizes “predict-or-abstain” and discusses calibrated uncertainty as essential to reduce high-confidence errors. citeturn0search11  
- **Add risk-control calibration:** Conformal prediction with a reject option is a well-studied way to wrap predictors so you can trade off coverage vs errors under assumptions like exchangeability; newer work continues to refine “reject option” approaches. citeturn0search31turn0search3turn0search23  
- **Operationally:** Use a composite confidence: `min(hard_gate_confidence, similarity_confidence, model_confidence)` and escalate when below threshold. This mirrors customer-support “confidence threshold triggers handoff” practices. citeturn1search24turn1search28

**3) Decision taxonomy & schema design**

You want a taxonomy that supports two functions simultaneously:

1) **Routing + safety policy** (what can ever be auto-decided), and  
2) **Learning + retrieval** (how to find similar decisions and infer your patterns).

A practical dev-workflow taxonomy for Flywheel-style orchestration is best modeled as **decision families** with explicit irreversible vs reversible actions, and evidence requirements.

Suggested top-level decision families (each with subtypes per repo/stack):

- **Change integration decisions:** merge PR, squash/rebase choice, bypass checks, merge queue, revert. citeturn2search2turn12search9  
- **Quality triage decisions:** failing tests (retry vs debug), flaky tests, lint/typecheck failures, dependency conflicts. (The “required status checks” model matters here because it changes when merging is allowed.) citeturn2search2  
- **Scope/product decisions:** accept/reject additional requirements, split issue, rename, “good enough” thresholds. (These map poorly to pure automation; treat as high-abstain early.) citeturn2search29  
- **Architecture/tech choices:** library selection, refactor vs patch, interface boundaries—high leverage and often cannot be inferred from shallow context. citeturn12search7turn0search5  
- **Security/safety decisions:** auth changes, payments/billing, data access, secrets, infra & CI changes. These should default to human approval + enforced review policies. citeturn12search7turn12search1turn12search16  
- **Deployment/ops decisions:** promote to prod, rollback, feature flag enablement. Trading-style “kill switch” analogies and auditability become relevant here. citeturn1search1turn1search21

What metadata to log per decision (to maximize learning value):

The strongest guidance is to treat decision data like an **append-only event stream** (event sourcing) so you can reconstruct “what the system knew” at the moment it asked (and what happened later). Event sourcing is specifically cited as making audit logs easy because events serialize naturally. citeturn9search1turn9search11

A concrete decision record schema (illustrative JSON) should include:

```json
{
  "decision_id": "uuid",
  "created_at": "2026-02-26T18:12:03Z",
  "phase": "observer|advisor|head_of_product",
  "decision_type": "merge_pr|retry_ci|request_changes|select_implementation|...",
  "repo": "owner/name",
  "branch": "feature/foo",
  "issue": { "tracker": "Linear", "id": "LIN-123", "title": "..." },
  "pr": { "provider": "GitHub", "number": 456, "url": "...", "head_sha": "..." },

  "question": "What should we do next?",
  "options_presented": [
    { "id": "merge", "label": "Merge", "pros": ["..."], "cons": ["..."] },
    { "id": "request_changes", "label": "Request changes", "pros": ["..."], "cons": ["..."] }
  ],

  "evidence_refs": {
    "diff_stat": { "files_changed": 7, "additions": 120, "deletions": 45 },
    "changed_paths": ["src/auth/*", ".github/workflows/ci.yml"],
    "ci": { "status": "pass|fail", "checks": [ { "name": "test", "state": "pass" } ] },
    "artifacts": ["log://...", "screenshot://...", "patch://..."]
  },

  "policy_context": {
    "risk_level": "low|medium|high",
    "hard_rules_triggered": ["auth_path", "workflow_change"],
    "allowed_actions": ["escalate", "request_changes"]
  },

  "model_context": {
    "retrieved_similar_decisions": ["uuid1", "uuid2"],
    "similarity_scores": [0.91, 0.88],
    "recommendation": "request_changes",
    "confidence": 0.62,
    "abstained": true
  },

  "human_response": {
    "actor": "you",
    "selected_option": "request_changes",
    "freeform_note": "Need tests for edge case X"
  },

  "outcome": {
    "merged": false,
    "later_incident": null,
    "followup": ["created_issue:LIN-124", "reran_ci:success"]
  }
}
```

(Structure informed by event-sourcing style auditability and by the need for explicit evidence + outcomes in selective automation.) citeturn9search1turn0search11

Detecting when the decision landscape changes (and the model needs to “re-learn”):

Use a mix of **explicit segmentation** and **drift monitoring**:

- Segment by **repo / project / stack** so retrieval doesn’t overgeneralize (“my preferences in a payments repo differ from a marketing site”).  
- Monitor for **data drift / concept drift** signals: rising override rates, increased post-merge failures, or “novelty” spikes in embeddings (new clusters). Drift and concept drift are standard terms for distribution/relationship change that degrade deployed predictors. citeturn9search8turn9search27turn9search28  
- Consider lightweight drift detectors (e.g., ADWIN) or simple statistical tests on structured features (e.g., file types, failing-check names) as pragmatic early warning, then operationally respond by tightening thresholds or reverting to Advisor/Observer behavior. citeturn9search19turn9search16

**4) Summarization & context presentation**

Your Discord escalations should behave like a high-quality **handoff packet**, not a log dump. Customer-support and helpdesk guidance consistently treats handoff quality as central: preserve the full context, summarize what happened, and make it easy for the human to act without re-reading everything. citeturn2search11turn1search28turn2search7

For technical decisions, the “right” context is usually:

- What changed (diff summary at file/function level)  
- Why it changed (intent, linked issue, expected behavior)  
- What evidence exists (test results, logs, screenshots, CI checks)  
- What risks are present (sensitive paths, config/infrastructure touches)  
- What options exist (merge, request changes, rollback, split PR…)  
- The system’s recommendation + confidence, and what would increase confidence (e.g., “rerun flaky test”, “add unit tests for X”).

This aligns with research and tooling trends around PR description generation and PR summarization: PR descriptions exist specifically to help reviewers understand *motivation + scope + testing*, and recent work evaluates LLM-based generation for PR descriptions/summaries. citeturn8search1turn8search16turn8search33

Two implementable summarization approaches that work well for dev context:

- **Hierarchical summarization pipeline:**  
  1) Extract structured facts cheaply (git diffstat, changed paths, CI check states).  
  2) Summarize each evidence artifact separately (test log → error synopsis; diff → key behavioral changes; screenshot → short caption).  
  3) Compose a final “decision brief” from those structured summaries.  
  This reduces LLM token usage by avoiding raw, high-volume inputs. It also matches general summarization practice of breaking long contexts into manageable sub-documents before synthesis. citeturn8search12turn8search4turn8search24  
- **PR-first summarization (high leverage):** Generate a PR summary/description artifact, then base the decision question on that artifact. GitHub’s documentation explicitly supports generating PR summaries with Copilot, highlighting how summaries fit into the PR description/comment workflow. citeturn8search33turn4search10

Discord UI building blocks you can rely on in Phase 1:

Discord supports interactive components (buttons, select menus) and modals for structured responses—ideal for “Approve / Reject / Need more info” actions plus a freeform “why” note. citeturn7search0turn7search3turn7search15 Use threads per decision so the decision brief, follow-up evidence, and final outcome are collocated (and can be re-indexed later).

Capturing “relevant screenshots (web pages, test results, diffs)” locally on macOS:

Playwright’s Node APIs support taking screenshots (including full-page) with simple calls, which makes it a pragmatic capture layer for CI dashboards, rendered diffs, or failing test pages (when a UI exists). citeturn8search2turn8search6

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["Discord message buttons example","GitHub pull request review screen screenshot","Linear issue view screenshot","GitHub branch protection settings screenshot"],"num_per_query":1}

Batching non-urgent decisions into periodic digests:

Borrow directly from escalation management patterns: do real-time escalation for urgent/high-risk items, while batching low-urgency items into a digest. This is common in human–AI escalation guidance (thresholding + deferring). citeturn1search28turn1search24 In your context, “digest items” could include: dependency bumps merged under rules, CI reruns, doc-only PRs, and build cache failures that self-resolved on retry.

A digest structure that prevents “attention collapse”:

- Group by repo/project and by decision family.  
- For each item, include the one-line outcome, the key evidence, and the learned rule that justified autonomy (“matched 17 prior cases; similarity 0.93; policy ‘merge when checks pass and no sensitive paths’”).  
This follows human–autonomy teaming guidance that well-designed AI alerts should highlight what matters without overwhelming the operator. citeturn1search3turn9search6

**5) Safety & override mechanisms**

A Decision Layer that can merge code (or trigger merges) is a safety-critical system in practice. Your safety strategy should be layered:

**Layer A: Hard rules (non-negotiable)**  
Hard rules define “never auto-decide” or “always require extra review” decision zones. In software delivery, this is commonly implemented with enforced review policy on sensitive paths (CODEOWNERS + required reviews, rulesets), plus protected branches and required status checks. citeturn12search1turn12search9turn2search2turn12search16 These controls are valuable because they are enforced by the platform, not by the agent’s judgment.

Security-driven examples for your orchestrator:

- Never auto-approve changes touching authentication/authorization/payments/secrets/CI workflows; require explicit human approval (or at least code-owner approval). This aligns with secure code review guidance emphasizing risk-based review depth and the fact that automated tools miss vulnerabilities that require contextual understanding. citeturn12search7turn12search0turn12search1  
- Prefer path-based enforcement (rulesets / required reviewers) over “friendly suggestions.” GitHub now explicitly distinguishes enforcement rules from CODEOWNERS ownership and supports targeting specific files/folders with review requirements. citeturn12search16turn12search1  
- Require signed/provenanced builds for high-stakes workflows when possible (SLSA threat model framing is a good mental model even if you don’t implement full SLSA). citeturn12search2turn12search13

**Layer B: Learned policy (allowed only inside the safe envelope)**  
Learned patterns can auto-handle low-stakes decisions, but only when hard rules allow the action + confidence is high.

**Layer C: Override & rollback**  
Override must be designed as a first-class interaction, not an exception:

- Every autonomous action should be accompanied by a reason + evidence, and every decision should be reversible where possible (e.g., revert PR, rollback deploy). This is aligned with the broader “keep human in command and able to override” theme in human-centered automation guidance. citeturn0search5turn1search15  
- Implement “kill switch” semantics: a single command/button that halts autonomous merges/deploys and forces all decisions to escalate. Trading guidance commonly treats kill switches and supervisory controls as essential safeguards. citeturn1search1turn1search21turn1search5

Audit trail requirements:

Event-sourcing style storage is ideal: it’s append-only, reconstructable, and naturally supports “what did it know when it decided?”—which is the core accountability question. citeturn9search1turn9search11 For dev decisions, include immutable references to evidence snapshots (patch files, logs, screenshots) so you can later review exactly what the Decision Layer saw.

**6) Architecture & implementation patterns**

Separate service vs embedded module:

For a solo-developer, macOS-local orchestration setup, the most practical “separation” is **logical separation with a stable internal API**, not necessarily a separate deployable service. You want the Decision Layer to be replaceable/testable, but adding inter-process complexity on a single machine can be counterproductive early. That said, a separate process can be useful if you want fault isolation (Decision Layer crash shouldn’t halt the orchestrator), and if you want independent rate limiting/caching. (This is a build trade-off, not a correctness requirement.)

A pragmatic compromise:

- Decision Layer as a TypeScript package inside the orchestrator repo (clear interfaces + its own persistence).  
- Optionally run it as a separate Node process later if isolation becomes valuable.

Core components (implementable in TypeScript today):

- **Decision Request API:** the orchestrator emits normalized decision requests (type, options, evidence pointers).  
- **Policy Engine:** hard rules + allow/deny + risk scoring.  
- **Case Store:** event log + embeddings + outcomes for retrieval.  
- **Summarizer:** produces the Discord “decision brief.”  
- **Dispatcher:** posts to Discord and receives button/select/modal responses; updates decision state. Discord’s components/interactions APIs support this well. citeturn7search0turn7search11turn7search23  
- **Integration Adapters:** pull issues and events from Linear (GraphQL + webhooks) and connect decision IDs back to the source issue/agent session. citeturn7search1turn7search8turn7search20

LLM choice for classification/summarization (cost-sensitive):

Given current Claude pricing, a common strategy is:

- Use a cheaper model for routine summarization + classification, and  
- Escalate only hard cases to a stronger model (or to you).

Anthropic’s published pricing (as of Feb 2026) shows **Haiku 4.5** at $1/MTok input and $5/MTok output, while **Sonnet 4.6** is $3/$15, and **Opus 4.6** is $5/$25. citeturn13view0turn7search21 Therefore:

- **Decision Layer default:** Claude Haiku 4.5 (fast, cheap) for “compose decision brief,” “classify decision type,” and “retrieve-and-recommend.” citeturn13view0  
- **Escalation assistant (optional):** Claude Sonnet 4.6 when the system is uncertain but you’d benefit from deeper synthesis (e.g., multi-file refactor risk, complicated CI failures). citeturn7search21turn13view0

Token cost estimates (order-of-magnitude, based on published prices):

If a routine decision-brief call uses ~1,100 input tokens and ~200 output tokens, the raw token cost is roughly:

- Haiku: ~$0.002 per decision  
- Sonnet: ~$0.006 per decision citeturn13view0

Prompt caching can reduce costs substantially when you reuse the same instruction/taxonomy prompt across many decisions; Anthropic pricing specifies cache reads at 0.1× base input price (with specific multipliers for cache writes). citeturn13view0 In practice, that means your “stable” system prompt can be treated as nearly free after warmup when you have multiple decisions per hour.

Decision history storage: JSON files vs SQLite vs vector DB

Start with **SQLite + filesystem artifacts**:

- SQLite is explicitly positioned as a self-contained, serverless, zero-configuration embedded database—well-suited to macOS-local single-user storage. citeturn8search3turn8search15  
- Use the filesystem for large artifacts (logs, screenshots, patches), and store content-addressed hashes + paths in SQLite.

For semantic retrieval, you have two practical local-first options:

1) **SQLite full-text + metadata filtering plus embeddings stored separately** (lowest complexity). SQLite’s FTS5 supports full-text indexes—useful for keyword retrieval of past decisions or notes. citeturn8search31  
2) **SQLite + vector extension** for true nearest-neighbor search. sqlite-vec is designed as a small vector search extension that runs anywhere SQLite runs and provides vector storage/query in embedded environments. citeturn10search0turn10search20

If you want a dedicated local vector store with TypeScript support, LanceDB explicitly provides embedded local-disk usage patterns and a JS/TS SDK reference, but it’s more infrastructure than you need in Phase 1. citeturn11search27turn11search17turn11search6

Local embeddings in TypeScript to minimize token usage:

Transformers.js supports “feature-extraction” pipelines and can generate embeddings in Node; model cards provide example usage for embeddings and cosine similarity. citeturn11search4turn11search9turn11search5 This can eliminate the need to spend LLM tokens just to compute similarity.

**7) Comparison with existing products**

What you can borrow from existing tools is less about model choice and more about **where checkpoints live** and **how evidence is packaged**.

Cyrus:

The Cyrus repo describes an agent that monitors issues, creates isolated worktrees, runs coding-agent sessions, and streams activity updates with rich interactions like dropdown selects and approvals; it positions these approvals as first-class UI elements, which is directly aligned with your Discord-based Decision Layer concept. citeturn4search0turn4search2turn4search9 As a TypeScript project, it’s also relevant for implementation patterns (Discord interactions + approvals wired into an agent loop). citeturn4search13turn7search0

GitHub Copilot Workspace / Copilot code review:

GitHub frames Copilot Workspace as a “task-centric” environment that generates plans and code changes which remain human-reviewed; and GitHub provides explicit workflows for Copilot code review and PR summaries, reinforcing the pattern that LLMs can assist review, but merges remain governed by existing repo policies. citeturn4search26turn4search10turn8search33 The archived user manual indicates Workspace includes references and file selection controls, reflecting a principle your Decision Layer should copy: show what evidence was used and allow the human to adjust it. citeturn4search35

Devin and enterprise coding agents:

Cognition’s launch messaging positions Devin as a teammate that completes tasks for humans to review; the general-availability announcement and the main product site describe a flow where humans review plans and PRs, implying built-in checkpoints. citeturn4search23turn5search7turn5search3 Third-party enterprise writeups describe “non-negotiable checkpoints” (planning + PR), which is consistent with the broader agent governance trend: autonomy is wrapped by mandated review steps. citeturn5search1turn5search3

Factory:

Factory positions itself around “agent-native development” and publishes a “Safe Autonomy Readiness Policy,” which signals an explicit governance-first framing (autonomy + safety/readiness policy). Even if you’re solo, the concept is valuable: autonomy should have an explicit readiness rubric, not only ad-hoc trust. citeturn5search9turn5search35turn5search0

Vercel v0:

Vercel’s positioning emphasizes enabling more people to build and ship; v0 docs and community posts show a Git workflow with branches, PRs, and previews—meaning v0’s ambiguity is controlled by funneling outputs into familiar Git review mechanics rather than “auto-ship.” citeturn5search34turn6search18turn6search17 The fact that workflow changes (publish button removed, PR-based publishing introduced) appear in community discussions is also a useful lesson: your Decision Layer should treat workflow mechanics as part of the contract and surface them clearly, because users depend on predictable gates. citeturn6search0turn6search5turn6search11

Bolt.new:

Bolt’s open-source repo describes a browser-based agent that can prompt/run/edit/deploy full-stack apps; Bolt’s own support docs emphasize export/zip workflows and continuing in an IDE, which implies human ownership of code remains central even if generation is automated. citeturn5search8turn5search12 The key takeaway for your Decision Layer is that “ambiguity handling” is often less about perfect clarifying questions and more about making the iteration/review loop cheap and reversible.

## Recommended Approach

Build this as an explicit **Decision Contract + Policy + Memory** system, where autonomy expands only by narrowing and then widening the allowed operating envelope.

Phase progression (what to actually implement, in order):

Start with the minimum architecture that guarantees: (a) reproducibility, (b) auditability, (c) safe interruption, and (d) low token burn.

**Phase 1: Observer**

Implement a Decision Layer that does not auto-decide, but builds the foundation for learning:

- Define a strict **DecisionRequest** interface with `decision_type`, `options`, and **evidence pointers** (not raw text). This forces upstream orchestrator components to produce structured evidence rather than dumping agent transcripts.  
- Store decisions as **append-only events** in SQLite (Event Sourcing style), and store artifacts (patch/log/screenshot) as immutable referenced blobs. citeturn9search1turn8search3  
- Implement Discord interactions: each decision is a thread containing:  
  1) Decision brief (summary),  
  2) Evidence attachments (top 1–3, expandable),  
  3) Buttons/selects for the allowed actions, plus a modal for rationale when needed. citeturn7search0turn7search15turn7search23  
- Add “always available” kill switch: a command that sets `autonomy_mode = MANUAL_ONLY` and causes any automatic behavior to abstain. (Trading governance treats kill switches as a key supervisory control concept.) citeturn1search21turn1search1  
- Safety rails from day one: enforce branch protections + required status checks for main branches, and configure CODEOWNERS / required reviewers for sensitive paths—even if it’s only you, you can still use code-owner rules as a forcing function. citeturn2search2turn12search1turn12search16

**Phase 2: Advisor**

Add selective autonomy, but in a narrow envelope:

- Implement a **hard-rule policy engine** (deny/allow + risk scoring) based on changed paths, decision type, and repository. Use secure review guidance to define “high-risk zones” (auth, secrets, infra) that never auto-merge. citeturn12search7turn12search0turn12search16  
- Add **case-based retrieval**:  
  - Generate embeddings locally (Transformers.js) for the decision summary + key evidence snippets; store embeddings in SQLite using sqlite-vec (or store in a side table and use a simple kNN initially). citeturn11search4turn11search9turn10search0  
  - Retrieve top-k similar past decisions filtered by repo/stack and compute a “consensus action.”  
- Implement **selective prediction**: only auto-decide when (a) hard rules allow it, (b) similarity is high, and (c) historical outcomes in that neighborhood are consistently good. (Selective classification formalizes this as maximizing accuracy on accepted predictions, with abstention when uncertain.) citeturn0search11turn0search31  
- Upgrade escalation quality: when abstaining, post a concise brief with (i) the top retrieved precedents, (ii) the recommended action, and (iii) what missing evidence would raise confidence (e.g., rerun flaky test, capture screenshot, add unit test). This mirrors bot-to-human best practices (clear triggers + context preservation). citeturn1search24turn2search7turn2search11

**Phase 3: Head of Product**

Expand autonomy mainly by (a) expanding the safe envelope and (b) improving drift detection, not by giving the model more raw power.

- Build per-repo “policy profiles” as editable preference descriptors, similar in concept to PRELUDE/CIPHER’s interpretable preference descriptions—except your descriptors should explicitly include safety boundaries (“never auto-merge auth changes”). citeturn3search2turn3search6turn12search16  
- Implement drift monitoring: track override rate, reversal rate (reverts/rollbacks), and novelty of incoming decisions. If drift signals spike, automatically tighten thresholds or revert to Advisor/Observer. citeturn9search8turn9search19turn9search27  
- Add periodic digests of autonomous actions with evidence summaries and “policy justification,” because humans need visibility to maintain calibrated trust and avoid automation bias. citeturn2search29turn1search3

## Risk Assessment

The main risks are not “the model is weak,” but “the system shape encourages preventable failure.”

**Automation bias and rubber-stamping**  
As volume rises, you may begin approving by default—especially if the system is “usually right.” Research shows incorrect algorithmic support can reduce human accuracy, particularly when it biases judgment early. Mitigation: keep decision briefs short, highlight uncertainty and contrary evidence, and require rationale on high-risk approvals. citeturn2search1turn2search29turn1search15

**False confidence on edge cases**  
LLM-driven recommendations can be confidently wrong; if you let those flow into merges/deploys, you get fast failure. Mitigation: enforce hard “never auto” rules for sensitive paths (auth, infra), and use selective classification with abstention so the system is rewarded for escalating rather than guessing. citeturn12search7turn0search11turn0search31

**Policy drift across projects**  
Your preferences will differ across repos and evolve over time. If you don’t segment and monitor drift, the decision layer will misapply old patterns. Mitigation: per-repo policy profiles + drift detection (override spikes, novelty). citeturn9search8turn9search27turn9search19

**Security regressions from “low-risk” misclassification**  
A small-looking change can be high risk (e.g., auth path touched by a refactor) and security flaws are often contextual. Mitigation: path-based enforcement (rulesets / required reviewers), protected branches, and secure code review checklists. citeturn12search16turn12search9turn12search7turn12search0

**Inadequate auditability for postmortems**  
If you do not store “what the system saw,” you won’t be able to diagnose why it made a decision or to learn reliably from mistakes. Mitigation: event-sourced decision logs + immutable evidence snapshots. citeturn9search1turn9search11

**Token cost creep**  
If the Decision Layer starts sending raw transcripts/diffs to an LLM, costs can balloon—especially with long-context requests. Mitigation: hierarchical summarization (structured extraction → small summaries → final brief), local embeddings, and prompt caching; rely on published token pricing and caching multipliers to budget. citeturn13view0turn11search4turn8search1

## References

Parasuraman, Sheridan & Wickens, “A model for types and levels of human interaction with automation” — foundational framework for staged automation across information/decision/action functions. citeturn2search12turn2search4

SAE J3016 (levels of driving automation) — useful autonomy-level analogy for defining explicit responsibility boundaries and constrained operating domains. citeturn0search24turn0search28

MIT OCW human-centered automation principles — emphasizes human-in-command, predictability, and informed oversight. citeturn0search5

PRELUDE/CIPHER (Gao et al., NeurIPS 2024) — learns latent preference descriptors from user edits and retrieves preferences from similar contexts (relevant blueprint for “learn my decisions over time without fine-tuning”). citeturn3search6turn3search2turn3search1

Selective classification / calibrated abstention — formal tools for “auto-decide vs escalate” with calibrated uncertainty. citeturn0search11turn0search7

Conformal prediction with reject option — risk/coverage control framing for abstaining when uncertain. citeturn0search31turn0search3turn0search23

Automation bias risks (CSET brief; HITL oversight pitfalls) — explains why “human in the loop” can still fail without careful design. citeturn2search29turn2search21

Human judgment degradation from incorrect AI support — experimental evidence that algorithmic errors can bias human decisions. citeturn2search1

GitHub protected branches and required status checks — concrete enforcement mechanisms for merge gating independent of the agent. citeturn2search2turn2search6turn2search18

GitHub CODEOWNERS and required reviewer rules — enforcement patterns for sensitive paths (critical for “never auto-approve auth/payment”). citeturn12search1turn12search16turn12search9

OWASP secure code review guidance — risk-based review emphasis; supports hard boundaries for security-sensitive changes. citeturn12search7turn12search0

SLSA threats/mitigations — software supply chain threat framing for tamper resistance and integrity controls. citeturn12search2turn12search13

Discord developer documentation (components + interactions + modals) — UI primitives needed for Discord-first decision workflows. citeturn7search0turn7search11turn7search15

Linear API and webhooks (including agent-session interaction) — relevant for integrating decision events with issue context in a TypeScript orchestrator. citeturn7search1turn7search8turn7search20

Playwright screenshots — practical basis for capturing evidence screenshots locally for escalation packets. citeturn8search2turn8search6

SQLite “About” and usage guidance — supports the embedded, serverless local storage strategy for a solo macOS system. citeturn8search3turn8search15

sqlite-vec / sqlite-vss and Faiss — embedded local vector search options and underlying similarity-search design principles. citeturn10search0turn10search1turn10search2

Sentence-BERT (SBERT) — semantic similarity embeddings foundation for “similar decision” retrieval. citeturn10search3

Transformers.js — local embeddings in JavaScript/Node to reduce token spend for similarity search. citeturn11search4turn11search9turn11search8

Anthropic Claude pricing + caching multipliers + model lineup — supports cost modeling and model selection (Haiku vs Sonnet vs Opus). citeturn13view0turn7search21turn7search6

Cyrus (TypeScript repo + Linear integration page) — real-world reference implementation of approvals + rich interactions in an agentic workflow anchored in Linear. citeturn4search0turn4search9turn4search13

GitHub Copilot Workspace + code review + PR summary docs — examples of human-steered checkpoints and LLM-assisted review artifacts. citeturn4search26turn4search10turn8search33

Cognition’s Devin announcements and docs — illustrates plan/PR checkpoints and collaborative review expectations in “autonomous engineer” positioning. citeturn4search23turn5search7turn5search3

Factory’s “agent-native development” + readiness policy framing — emphasizes autonomy governance as a product surface. citeturn5search9turn5search35turn5search0

Vercel v0 docs/FAQs — documents branch/PR workflow integration, reinforcing Git-native checkpoints as ambiguity control. citeturn6search18turn5search34turn6search17