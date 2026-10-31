# Agentic SDLC — Claude Code Plugin

A standards-anchored, agent-driven Software Development Lifecycle for Claude Code.
Run one command — `/agentic-sdlc:sdlc` (short: `/sdlc`) — and the wizard detects your
project state and drives seven phases (Prepare → Define → Design → Develop → Verify →
Release → Operate) with a roster of **35 specialized subagents**.

📖 **[How it works — visual guide](https://orchestratedbyalex.github.io/agentic-sdlc-plugin/)** —
the seven phases, install, and model routing on one page.

## Requirements

- **Claude Code** (CLI, desktop, web, or IDE extension).
- **Node.js 18+** — the plugin's only executable (`scripts/sdlc-state.mjs`) is zero-dependency
  ESM and uses the built-in `node:test` runner. No `npm install` step.

## Install (from the marketplace)

```text
# inside Claude Code:
/plugin marketplace add orchestratedbyalex/agentic-sdlc-plugin
/plugin install agentic-sdlc@agentic-sdlc-marketplace
/agentic-sdlc:sdlc
```

## Install (local development)

```bash
claude --plugin-dir /ABSOLUTE/PATH/TO/agentic-sdlc-plugin
# inside Claude Code:
/reload-plugins
/agentic-sdlc:sdlc
```

## Quick start

Run `/sdlc` in any repository. The wizard:

1. **Detects state** — `greenfield` (empty folder), `existing` (code, no SDLC metadata), or
   `resume` (metadata present) — and prints a seven-phase status board.
2. **Routes you** — scaffolds a greenfield skeleton, sets up an existing repo, or resumes
   exactly where you left off (down to the specific agent).
3. **Drives each phase** by dispatching its subagents (in parallel where independent), runs a
   validation **gate** after each group, and routes failures back to the responsible author.
4. **Records evidence** in *your* repo — requirements under `docs/requirements/`, design under
   `docs/design/`, operations under `docs/operate/`, and all state in
   `docs/requirements/sdlc-metadata.yml`.

State is deterministic and resumable: every status change goes through `sdlc-state.mjs`, never
an ad-hoc edit, so you can stop and resume any time — including mid-loop: gate strike counts,
the Verify cycle, the active implementation plan, and a full gate-verdict log persist in the
metadata, so an interruption never resets a review loop's bounds. Route-backs are transitions
too: when Verify demands rework (or Release uncovers a Verify miss), the earlier phase is
deterministically **reopened** — only the responsible agents reset, and resume lands on the
rework, not on the phase that sent it back. Completing a phase records an **evidence
attestation** citing the gate verdict that proved it.

## Model routing

Each subagent runs under a model **profile**, so you can trade cost against wall-clock without
touching the gates. Switch any time (persisted deterministically in `sdlc-metadata.yml`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sdlc-state.mjs" config --model-profile <quality|balanced|economy>
```

- **quality** — every agent runs on the session model. Most thorough, most expensive.
- **balanced** (default) — mechanical agents (build/lint analysis, the regression run, the
  dependency/telemetry monitors) drop to a small fast model and analysis/authoring agents to a
  mid model. Cheaper and faster, same gates.
- **economy** — pushes the non-critical tiers to the smallest models for the lowest cost.

Whatever the profile, the **full tier always inherits the session model** — every reviewer and
validator, the planner, the clarifier, the code/test/implementer authors, and the feedback-loop.
Model routing never downgrades a gate.

## The seven phases

| Phase | Purpose | Anchored in |
|-------|---------|-------------|
| **Prepare** | Map the project; produce a CLAUDE.md the agents can rely on | ISO/IEC/IEEE 12207:2026 |
| **Define** | Functional / non-functional requirements + user stories, gated | IEEE 12207:2026 |
| **Design** | Architecture, component specs, ADRs, STRIDE-lite threat model | IEEE 1016, Microsoft SDL, Nygard ADRs |
| **Develop** | Plan → implement + test (proportionate to change tier) → review | Microsoft SDL |
| **Verify** | Coverage, independent review, real production build, regression | IEEE 1012, ISO/IEC 25010 |
| **Release** | Changelog, version bump, staged commit + tag + rollback plan (human-authorized; pre-authorizable via a git grant, publish never) | ITIL 4 |
| **Operate** | Triage, dependency/telemetry monitoring, post-release health, feedback + accreted lessons into the next cycle | ITIL 4, ISO/IEC 27001, DORA |

## How it's built (the two-zone model)

The plugin carries the **process** ("how"); your target repository receives the **evidence**
("what" — requirements, design docs, `sdlc-metadata.yml`). That separation is load-bearing:
the plugin stays generic, your repo accumulates the lifecycle record.

- The `/sdlc` wizard (`commands/sdlc.md`) — the orchestrator entry point.
- **35 subagents** (`agents/`), dispatched via the Task tool, honoring parallelism and a strict
  **reviewer ≠ author** rule (reviewers are read-only).
- **7 machine-readable phase playbooks** (`phases/`) — groups, modes, gates, post-phase state.
- **Deterministic, tested state** (`scripts/sdlc-state.mjs`) — the single source of metadata truth.
- **Deterministic guardrails** (`hooks/hooks.json` → `scripts/sdlc-guard.mjs`) — a PreToolUse
  hook turns publish commands (`git commit`/`tag`/`push`, `gh release`, `npm publish`) into an
  explicit permission **ask** (the human approving the prompt *is* the gate) and **denies**
  direct edits of `sdlc-metadata.yml`, pointing back at the state script. Hooks fire
  session-wide wherever the plugin is enabled — the ask-not-deny design keeps that safe.
  You can move that gate earlier with a **git grant** (see below): the same hook then
  **allows** the covered commit once the gate has PASSed, and spends the grant.
- **Human checkpoints at exactly three altitudes** — Define completes only after your
  requirements sign-off; Design completes only after you decide the ADR trade-offs
  (new-decision ADRs enter `proposed`; your approval accepts them); and a new Operate cycle
  starts only on your explicit go (go / defer / override) — never on an agent's say-so.
- Artifact templates (`templates/`) and two skills (`sdlc-conventions`, `sdlc-feature-intake`).
- **Configurable model routing** (`quality` / `balanced` / `economy`) that never downgrades the
  judgment-bearing agents or the gates.
- **Agent evals** (`evals/`) — the gate agents are themselves tested: labelled golden fixtures
  (clean ⇒ PASS, tests-green-but-build-broken ⇒ FAIL, no-build-step ⇒ honest PASS, a hardcoded
  API key arriving as the uncommitted diff ⇒ security-blocker FAIL, a test command that exits 0
  collecting zero tests ⇒ FAIL) run headless through the real plugin and asserted on the
  machine-parsable `VERDICT:` line. Billed and opt-in (`SDLC_EVALS=1 node evals/run.mjs`),
  never part of `node --test`.

## Pre-authorizing commits (git grants)

Long runs — an IV&V cycle, a QA pass, a census over a large codebase — should finish without
someone sitting on the Allow button. Git stays human-authorized; a **grant** just moves your
authorization earlier in time. Ask the wizard in plain language ("pre-authorize the commit
and push for the release", "auto-complete this feature's commit") or run the state script:

```bash
node "$PLUGIN/scripts/sdlc-state.mjs" grant --actions commit,push --scope phase:release --reason "IV&V run"
node "$PLUGIN/scripts/sdlc-state.mjs" grants              # list (active first)
node "$PLUGIN/scripts/sdlc-state.mjs" revoke --all        # or --id G-001
```

- **Scopes:** `task:PLAN-NNN` (one Develop run), `step:<phase>/<agent>`, `phase:<phase>`,
  `cycle`. **Actions:** `commit`, `push`, `tag`. **Modes:** `once` (default; spent on use)
  or `standing` (until revoked). First-time setup also offers a one-time
  "pre-authorize commits?" pick (none / commit / commit + push) that issues a standing
  cycle-wide grant.
- **Bound to evidence:** the hook allows the commit only when the scope's latest gate verdict
  is PASS (or WAIVED); a FAIL, a different plan, or no verdict yet falls back to the normal
  permission prompt. The grant is spent at allow time and every event is logged to the
  gate log; the commit carries an `SDLC-Grant: G-NNN` trailer.
- **Self-invalidating:** `reopen` revokes the grants that covered the reopened work; `cycle`
  expires all of them; `revoke` works at any time and never prompts.
- **Never grantable:** `npm publish`, `gh release`, and the three `HUMAN_CHECKPOINT`
  sign-offs — those are decisions, not permissions. Subagents never commit, grant or no
  grant; only the orchestrator does, after the gate.

## Test

```bash
node --test          # 189 tests, all green (state logic + hook guard + evals lib + plugin structure)
```

The model-free suite above always runs clean on CI and contributor machines. The billed agent
evals are separate and explicit — see [evals/README.md](evals/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the design invariants, agent conventions, and the
version-bump policy. Contributor guidance for working *in* this repo lives in
[CLAUDE.md](CLAUDE.md).

## License

[GNU AGPL-3.0-or-later](LICENSE.md) © 2026 [@orchestratedbyalex](https://github.com/orchestratedbyalex).

Free to use, run, and modify — including inside companies. If you distribute it or a modified
version (or run a modified version as a network service), you must release your source under the
same AGPL license. You can build on it; you can't close it up and resell it as proprietary.
