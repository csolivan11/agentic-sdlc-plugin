# Git grants — pre-authorized commit / push / tag

Read by the /sdlc wizard when Step 0 reports an active grant, when a completion is reached
with one, or when the user asks to pre-authorize, list or revoke. A grant is the human git
gate (invariant 4) **moved earlier in time**: the human authorizes a commit (and optionally a
push and tag) *before* the work completes, so an IV&V run, a QA cycle or a census can finish
without a human sitting on the Allow button. The authorization is explicit, scoped, bound to
a PASSed gate, single-use by default, revocable at any time, and fully logged.

## What a grant is

    id:      G-001                     # never reused
    actions: commit[,push[,tag]]       # publish / gh release are NEVER grantable
    scope:   cycle | phase:<phase> | step:<phase>/<agent> | task:<PLAN-id>
    mode:    once (default) | standing
    status:  active | consumed | revoked | expired

| Scope | Covers | Evidence binding (checked by the guard at commit time) |
|-------|--------|-------------------------------------------------------|
| `task:PLAN-NNN` | one Develop run | `runtime.active_plan` is that plan AND develop's latest gate verdict is PASS/WAIVED |
| `step:<phase>/<agent>` | the completion right after that agent's group passes its gate | that phase's latest gate verdict is PASS/WAIVED |
| `phase:<phase>` | that phase's completion | that phase's latest gate verdict is PASS/WAIVED |
| `cycle` | any completion in the current cycle | the newest gate verdict overall is PASS/WAIVED |

A FAIL verdict, or no verdict yet, means the grant does not apply and the guard asks the
human as it always did. `once` spends each action on first use and becomes `consumed` when
every action it carries has been used; `standing` stays active until revoked or expired.

Grants are invalidated automatically: `reopen --phase P` revokes the grants scoped to P, to
`step:P/*`, to `cycle`, and (P = develop) to every `task:`; `cycle` expires whatever is
left. The work changed, so the human re-authorizes.

## Issuing, listing, revoking (deterministic — never hand-edit the YAML)

    node "${CLAUDE_PLUGIN_ROOT}/scripts/sdlc-state.mjs" grant --actions commit[,push[,tag]] --scope <scope> [--mode once|standing] [--reason "<why>"]
    node "${CLAUDE_PLUGIN_ROOT}/scripts/sdlc-state.mjs" grants
    node "${CLAUDE_PLUGIN_ROOT}/scripts/sdlc-state.mjs" revoke --id G-NNN | --all [--reason "<why>"]

Running `grant` raises **one** permission prompt from the guard — *that* approval is the
human gate; the covered git command will not prompt again. Run it only when the user asked
for a pre-authorization (in `$ARGUMENTS` as `grant …`, or in plain language: "pre-authorize
the commit and push for the release", "auto-complete the IV&V run"), and echo back the
exact scope and actions before running it. Translate plain language conservatively:
"commit" → `commit`; "commit and push" → `commit,push`; "for the release" → `phase:release`;
"for this feature" → `task:<active plan>`; "for the whole run / cycle" → `cycle`; "every
time" → `--mode standing`. Never add `push` or `tag` the user did not name. `revoke` never
prompts — "revoke the grant" / "stop auto-committing" → `revoke --all` (or `--id`).

## The board line (Step 1)

Always render one line from Step 0's `grants` (the active ones), so an authorization is as
visible as the model profile:

    🔑 Grants: G-001 commit+push @ phase:release (once, unused) · G-002 commit @ cycle (standing)
    🔑 Grants: none — say "pre-authorize …" to let a completion commit without a prompt

`unused` / `commit used` reflects the grant's `used` list.

## Committing under a grant (the completion protocol)

Only the **orchestrator** commits, only **after** the phase's gate verdict is recorded as
PASS (or WAIVED), and only when Step 0 / `grants` shows an active grant whose scope covers
this completion. Subagents keep their contract unchanged: they stage and suggest, never
commit. When a grant applies:

1. Record the gate verdict (`gate-log … PASS`) and the state updates (`complete …`,
   `plan-add`, `counts`) FIRST — the guard checks the verdict, and the commit should carry
   the updated metadata.
2. Run the add + commit (+ tag + push, only the actions the grant carries) as **one** Bash
   command, with the grant id as a commit trailer:

       git add <touched files> docs/requirements/sdlc-metadata.yml && git commit -m "<suggested message>" -m "SDLC-Grant: G-NNN"

   For a release: `… && git tag -a v<VERSION> -m "v<VERSION>" && git push --follow-tags`
   (only when the grant carries `tag` / `push`). Never add `npm publish` / `gh release` to
   the chain — they are never grantable and would turn the whole command into a prompt.
3. Confirm with `grants` that the grant now shows the action under `used` (or `consumed`),
   and report the commit sha + the grant id in the phase summary. If the guard asked anyway,
   the grant did not apply (the reason says why — a FAIL verdict, a different plan, no
   verdict yet): do NOT retry; stage + suggest as usual and tell the user.

Without an applicable grant, every completion behaves as before: stage, suggest the commit
message, hand the human the commands (and, for Release, the rollback plan).

## What a grant never does

- It never pre-approves a `HUMAN_CHECKPOINT` (Define / Design sign-off, Operate go/no-go)
  or resolves a `HUMAN_REVIEW_REQUIRED` escalation — those are decisions, not permissions.
- It never covers `npm publish`, `gh release create`, or any registry action.
- It never lets a subagent commit; reviewer ≠ author and the release reviewer's
  "author committed = FAIL" check are unchanged.
