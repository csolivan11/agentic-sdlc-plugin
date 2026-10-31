import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decide } from '../scripts/sdlc-guard.mjs'

const GUARD = fileURLToPath(new URL('../scripts/sdlc-guard.mjs', import.meta.url))

const bash = command => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (tool_name, file_path) => ({ tool_name, tool_input: { file_path } })

// --- Invariant 4: git stays human-gated → "ask" on publish/history commands ---

test('guard asks on git commit / git tag <name> / git push', () => {
  for (const cmd of ['git commit -m "feat: x"', 'git tag v1.0.0', 'git push origin main']) {
    const d = decide(bash(cmd))
    assert.equal(d?.decision, 'ask', `${cmd}: expected ask`)
    assert.ok(d.reason.length > 0, `${cmd}: empty reason`)
  }
})

test('guard asks when the publish command hides mid-chain, in a substitution, or behind git flags', () => {
  for (const cmd of [
    'npm test && git push',
    'echo $(git push origin main)',
    'git -C packages/core commit -m x',
    'FOO=1 env BAR=2 git push',
  ]) {
    assert.equal(decide(bash(cmd))?.decision, 'ask', `${cmd}: expected ask`)
  }
})

test('guard asks on gh release create and npm/pnpm/yarn publish', () => {
  for (const cmd of ['gh release create v1.0.0 --notes x', 'npm publish', 'pnpm publish', 'yarn publish']) {
    assert.equal(decide(bash(cmd))?.decision, 'ask', `${cmd}: expected ask`)
  }
})

test('guard stays silent on read-only git/gh/npm usage', () => {
  for (const cmd of [
    'git status', 'git log --oneline', 'git tag', 'git tag -l', 'git tag --list',
    'gh release list', 'gh release view v1.0.0',
    'npm test', 'npm view left-pad',
    'echo "git push is human-gated"',   // quoted prose, not a command
    'git log --grep "commit message"',  // 'commit' as an argument, not a subcommand
  ]) {
    assert.equal(decide(bash(cmd)), null, `${cmd}: expected no opinion`)
  }
})

test('guard stays silent on --dry-run variants', () => {
  for (const cmd of ['git push --dry-run', 'git commit --dry-run', 'npm publish --dry-run']) {
    assert.equal(decide(bash(cmd)), null, `${cmd}: expected no opinion`)
  }
})

// --- Invariant 2: sdlc-metadata.yml is script-owned → "deny" direct writes ---

test('guard denies Edit/Write/MultiEdit on sdlc-metadata.yml, pointing at the state script', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    const d = decide(edit(tool, 'docs/requirements/sdlc-metadata.yml'))
    assert.equal(d?.decision, 'deny', `${tool}: expected deny`)
    assert.match(d.reason, /sdlc-state\.mjs/, `${tool}: reason must point at the state script`)
  }
})

test('guard leaves the plugin template and unrelated files alone', () => {
  assert.equal(decide(edit('Edit', 'templates/sdlc-metadata.yml')), null)
  assert.equal(decide(edit('Write', 'docs/requirements/functional/FR-001-x.md')), null)
})

test('guard denies Bash writes aimed at sdlc-metadata.yml', () => {
  for (const cmd of [
    'echo "sdlc:" > docs/requirements/sdlc-metadata.yml',
    'cat header.yml >> docs/requirements/sdlc-metadata.yml',
    "sed -i '' 's/pending/completed/' docs/requirements/sdlc-metadata.yml",
    'grep -v cycle meta.yml | tee docs/requirements/sdlc-metadata.yml',
    'cp backup.yml docs/requirements/sdlc-metadata.yml',
    'mv scratch.yml docs/requirements/sdlc-metadata.yml',
  ]) {
    const d = decide(bash(cmd))
    assert.equal(d?.decision, 'deny', `${cmd}: expected deny`)
    assert.match(d.reason, /sdlc-state\.mjs/, `${cmd}: reason must point at the state script`)
  }
})

test('guard allows Bash reads of sdlc-metadata.yml and the state script itself', () => {
  for (const cmd of [
    'cat docs/requirements/sdlc-metadata.yml',
    'grep -n cycle docs/requirements/sdlc-metadata.yml > /tmp/out.txt',
    'node /some/plugin/scripts/sdlc-state.mjs complete --phase develop',
    'cp docs/requirements/sdlc-metadata.yml /tmp/backup.yml',
  ]) {
    assert.equal(decide(bash(cmd)), null, `${cmd}: expected no opinion`)
  }
})

// The guard is defense-in-depth over the prompt contract, not a wall: on anything it
// doesn't positively recognize as gated, it stays silent so normal work never breaks.
test('guard fails open on unknown tools and malformed input', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'docs/requirements/sdlc-metadata.yml' } }), null)
  assert.equal(decide({ tool_name: 'Bash', tool_input: {} }), null)
  assert.equal(decide({}), null)
  assert.equal(decide(null), null)
})

// --- CLI: the hook protocol (JSON on stdin → hookSpecificOutput on stdout, exit 0) ---

function runGuard(stdin) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
  })
}

test('CLI: an ask decision is emitted as PreToolUse hookSpecificOutput JSON', () => {
  const r = runGuard(bash('git push origin main'))
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0)
})

test('CLI: a deny decision is emitted the same way', () => {
  const r = runGuard(edit('Write', 'docs/requirements/sdlc-metadata.yml'))
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /sdlc-state\.mjs/)
})

test('CLI: no opinion means no output and exit 0 (normal permission flow applies)', () => {
  const r = runGuard(bash('ls -la'))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('CLI: unparseable stdin fails open — exit 0, no output', () => {
  const r = runGuard('this is not json {{{')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

// --- Git grants: a human-issued, scoped, gate-bound pre-authorization turns the "ask"
// into an "allow" — and is consumed on the spot (fail closed: a failed command spends it).

import { initMetadata, parseMetadata, issueGrant, recordGateVerdict, revokeGrants } from '../scripts/sdlc-state.mjs'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const TEMPLATE = readFileSync(fileURLToPath(new URL('../templates/sdlc-metadata.yml', import.meta.url)), 'utf8')
const D = '2026-10-31'
function meta({ actions = ['commit'], scope = 'phase:develop', mode = 'once', verdicts = ['develop code_reviewer PASS'] } = {}) {
  let y = initMetadata(TEMPLATE, { name: 'x', version: '0.1.0', mode: 'existing' })
  y = issueGrant(y, { actions, scope, mode, date: D }).content
  for (const v of verdicts) {
    const [phase, gate, verdict] = v.split(' ')
    y = recordGateVerdict(y, { phase, gate, verdict, date: D }).content
  }
  return y
}
const grantOf = (content, id = 'G-001') => parseMetadata(content).runtime.grants.find(g => g.id === id)

test('guard allows git commit under a matching grant and consumes it in the same decision', () => {
  const d = decide(bash('git commit -m "feat: x"'), { metadataContent: meta(), date: D })
  assert.equal(d.decision, 'allow')
  assert.match(d.reason, /G-001/)
  assert.match(d.reason, /phase:develop/)
  assert.deepEqual(d.consumed, [{ id: 'G-001', action: 'commit' }])
  const g = grantOf(d.content)
  assert.equal(g.status, 'consumed') // once + single action → spent
  assert.deepEqual(g.used, ['commit'])
  // the same command again: the grant is spent → back to the human gate
  const again = decide(bash('git commit -m "feat: y"'), { metadataContent: d.content, date: D })
  assert.equal(again.decision, 'ask')
})

test('guard allows a commit && push chain only when the grant carries both actions', () => {
  const commitOnly = decide(bash('git commit -m x && git push origin main'), { metadataContent: meta(), date: D })
  assert.equal(commitOnly.decision, 'ask')
  assert.match(commitOnly.reason, /push/)
  assert.equal(commitOnly.content, undefined) // nothing consumed on an ask
  const both = decide(bash('git commit -m x && git push origin main'), { metadataContent: meta({ actions: ['commit', 'push'] }), date: D })
  assert.equal(both.decision, 'allow')
  assert.deepEqual(both.consumed, [{ id: 'G-001', action: 'commit' }, { id: 'G-001', action: 'push' }])
  assert.equal(grantOf(both.content).status, 'consumed')
})

test('guard allows git tag under a tag grant; bare git tag -l stays silent', () => {
  const y = meta({ actions: ['tag'] })
  assert.equal(decide(bash('git tag -a v1.0.0 -m v1.0.0'), { metadataContent: y, date: D }).decision, 'allow')
  assert.equal(decide(bash('git tag -l'), { metadataContent: y, date: D }), null)
})

test('a standing grant allows repeatedly and stays active', () => {
  const y = meta({ scope: 'cycle', mode: 'standing' })
  const a = decide(bash('git commit -m a'), { metadataContent: y, date: D })
  assert.equal(a.decision, 'allow')
  const b = decide(bash('git commit -m b'), { metadataContent: a.content, date: D })
  assert.equal(b.decision, 'allow')
  assert.equal(grantOf(b.content).status, 'active')
})

test('guard falls back to ask when the grant\'s gate binding does not hold, naming the gap', () => {
  const failed = decide(bash('git commit -m x'), { metadataContent: meta({ verdicts: ['develop code_reviewer FAIL'] }), date: D })
  assert.equal(failed.decision, 'ask')
  assert.match(failed.reason, /FAIL/)
  assert.match(failed.reason, /G-001/)
  const none = decide(bash('git commit -m x'), { metadataContent: meta({ verdicts: [] }), date: D })
  assert.equal(none.decision, 'ask')
  assert.match(none.reason, /no gate verdict/i)
})

test('guard asks when no grant applies, is revoked, metadata is absent, or metadata is garbage', () => {
  const wrongAction = decide(bash('git push'), { metadataContent: meta(), date: D })
  assert.equal(wrongAction.decision, 'ask')
  let y = meta()
  y = revokeGrants(y, { id: 'G-001', date: D }).content
  assert.equal(decide(bash('git commit -m x'), { metadataContent: y, date: D }).decision, 'ask')
  assert.equal(decide(bash('git commit -m x')).decision, 'ask') // 0.4.1 behaviour, no ctx at all
  assert.equal(decide(bash('git commit -m x'), { metadataContent: 'nope: [' , date: D }).decision, 'ask')
})

test('publish is never grantable: npm publish / gh release create still ask under any grant', () => {
  const y = meta({ actions: ['commit', 'push', 'tag'], scope: 'cycle', mode: 'standing' })
  assert.equal(decide(bash('npm publish'), { metadataContent: y, date: D }).decision, 'ask')
  assert.equal(decide(bash('gh release create v1.0.0 --notes x'), { metadataContent: y, date: D }).decision, 'ask')
  // and a chain mixing a grantable op with a publish is an ask as a whole (nothing consumed)
  const mixed = decide(bash('git push && npm publish'), { metadataContent: y, date: D })
  assert.equal(mixed.decision, 'ask')
  assert.equal(mixed.content, undefined)
})

test('issuing a grant is itself the human gate: `sdlc-state.mjs grant` asks; revoke/grants stay silent', () => {
  for (const cmd of [
    'node /p/scripts/sdlc-state.mjs grant --actions commit --scope phase:release',
    'cd repo && node "${CLAUDE_PLUGIN_ROOT}/scripts/sdlc-state.mjs" grant --actions commit,push --scope cycle --mode standing',
  ]) {
    const d = decide(bash(cmd), { metadataContent: meta(), date: D })
    assert.equal(d?.decision, 'ask', `${cmd}: expected ask`)
    assert.match(d.reason, /human gate/i)
    assert.match(d.reason, /commit/)
  }
  assert.equal(decide(bash('node /p/scripts/sdlc-state.mjs revoke --all')), null)
  assert.equal(decide(bash('node /p/scripts/sdlc-state.mjs revoke --id G-001 --reason done')), null)
  assert.equal(decide(bash('node /p/scripts/sdlc-state.mjs grants')), null)
  assert.equal(decide(bash('node /p/scripts/sdlc-state.mjs complete --phase develop')), null)
})

test('CLI: an allow is emitted as hookSpecificOutput JSON and the consumed grant is written back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-guard-'))
  const path = join(dir, 'docs/requirements/sdlc-metadata.yml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, meta())
  const input = { ...bash('git commit -m x'), cwd: dir }
  const r = runGuard(input)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /G-001/)
  assert.equal(grantOf(readFileSync(path, 'utf8')).status, 'consumed')
  const r2 = runGuard(input)
  assert.equal(JSON.parse(r2.stdout).hookSpecificOutput.permissionDecision, 'ask')
})
