#!/usr/bin/env node
// sdlc-guard.mjs — PreToolUse hook guard for the Agentic SDLC plugin.
// Zero dependencies. Pure decision core (decide) + stdin/stdout CLI.
//
// Makes two design invariants deterministic instead of prompt-enforced:
//   4 — git stays human-authorized: publish/history commands (git commit/tag/push,
//       gh release, npm publish) get an "ask" — the human approving the
//       permission prompt IS the gate, so ask, never deny. A human may instead
//       pre-authorize commit/push/tag with a GRANT (state script `grant`, itself an
//       ask): when an active grant covers every gated git op in the command and its
//       scope's latest gate verdict is PASS/WAIVED, the guard answers "allow" and
//       spends the grant on the spot. publish/release are never grantable.
//   2 — sdlc-metadata.yml has exactly one writer (scripts/sdlc-state.mjs):
//       direct edits are denied with a pointer at the state script.
//
// Fails open by design: on anything not positively recognized as gated the guard
// stays silent (normal permission flow applies). It is defense-in-depth over the
// prompt contract, not a wall — shell parsing here is approximate on purpose.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseMetadata, matchGrant, consumeGrant } from './sdlc-state.mjs'

const STATE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sdlc-state.mjs')
const META_REL = 'docs/requirements/sdlc-metadata.yml'

const METADATA = /sdlc-metadata\.ya?ml/
// the plugin's own template file is not the state file
const isMeta = t => METADATA.test(t) && !t.includes('templates/')

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const GIT_GATED = new Set(['commit', 'tag', 'push'])
const GH_RELEASE_READONLY = new Set(['list', 'view', 'download'])
const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn'])
const WRAPPERS = new Set(['env', 'command', 'sudo', 'nohup', 'time'])

function askReason(matched) {
  return `Human gate (Agentic SDLC invariant 4): "${matched}" publishes or rewrites shared ` +
    'history. SDLC agents stage and suggest — the human approving this prompt is the gate.'
}

function grantAskReason(detail) {
  return `Issuing a git pre-authorization (Agentic SDLC grant: ${detail}). Approving this ` +
    'prompt IS the human gate — the covered git command will run without another prompt, ' +
    'once its scope\'s gate has PASSed. Revoke any time with `revoke`.'
}

function allowReason(consumed) {
  const by = consumed.map(c => `${c.action} under ${c.id} (${c.scope}, issued ${c.issued})`).join('; ')
  return `Pre-authorized by the human (Agentic SDLC grant): ${by}. The grant is spent now — ` +
    'if the command fails, re-grant.'
}

function denyReason(what) {
  return `${what} blocked (Agentic SDLC invariant 2): sdlc-metadata.yml has exactly one ` +
    `writer. Use the state script instead: node ${STATE_SCRIPT} ` +
    '<init|complete|config|brief|counts|plan-add|cycle|gate-log|plan-active|clarifier-round|loop-reset|reopen|grant|grants|revoke>.'
}

// Split into simple-command segments across chains, pipes, and substitutions,
// then tokenize past env assignments and transparent wrappers.
function segments(command) {
  return command.split(/\|\||&&|;|\||\n|\$\(|`|\(|\)/).map(s => s.trim()).filter(Boolean)
}

function tokens(segment) {
  const toks = segment.split(/\s+/)
  let i = 0
  while (i < toks.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || WRAPPERS.has(toks[i]))) i++
  return toks.slice(i)
}

// First non-flag token after argv[0]; skips the argument of git's -C / -c.
function subcommand(toks) {
  for (let j = 1; j < toks.length; j++) {
    const t = toks[j]
    if (t === '-C' || t === '-c') { j++; continue }
    if (t.startsWith('-')) continue
    return { sub: t, rest: toks.slice(j + 1) }
  }
  return { sub: null, rest: [] }
}

// Every gated op in the command, in order: { matched, action } — `action` is the
// grantable git verb (commit|push|tag) or null for the never-grantable publish ops.
function gatedOps(command) {
  const ops = []
  for (const seg of segments(command)) {
    const toks = tokens(seg)
    const cmd = toks[0]
    if (!cmd) continue
    const { sub, rest } = subcommand(toks)
    if (cmd === 'git' && GIT_GATED.has(sub)) {
      if (rest.includes('--dry-run')) continue
      // bare `git tag` / `git tag -l` only lists — the Release agents do that a lot
      if (sub === 'tag' && (rest.length === 0 || rest.includes('-l') || rest.includes('--list'))) continue
      ops.push({ matched: `git ${sub}`, action: sub })
    } else if (cmd === 'gh' && sub === 'release') {
      const ghSub = rest.find(t => !t.startsWith('-'))
      if (!ghSub || GH_RELEASE_READONLY.has(ghSub)) continue
      ops.push({ matched: `gh release ${ghSub}`, action: null })
    } else if (NPM_LIKE.has(cmd) && sub === 'publish') {
      if (rest.includes('--dry-run')) continue
      ops.push({ matched: `${cmd} publish`, action: null })
    }
  }
  return ops
}

// `node …/sdlc-state.mjs grant …` is how a human pre-authorizes git: the prompt it raises
// is the gate itself. Returns the grant's argv detail, or null when the command isn't one.
function grantIssuance(command) {
  for (const seg of segments(command)) {
    const toks = tokens(seg)
    const i = toks.findIndex(t => /sdlc-state\.mjs["']?$/.test(t))
    if (i === -1 || toks[i + 1] !== 'grant') continue
    return toks.slice(i + 2).join(' ') || '(no arguments)'
  }
  return null
}

function checkBashPublish(command, ctx) {
  const issuing = grantIssuance(command)
  if (issuing !== null) return { decision: 'ask', reason: grantAskReason(issuing) }
  const ops = gatedOps(command)
  if (!ops.length) return null
  const first = ops[0]
  const ask = (extra) => ({ decision: 'ask', reason: askReason(first.matched) + (extra ? ` No grant applies: ${extra}` : '') })
  // publish/release are never grantable — one in the chain makes the whole command an ask
  const ungrantable = ops.find(op => op.action === null)
  if (ungrantable) return { decision: 'ask', reason: askReason(ungrantable.matched) }
  const md = typeof ctx.metadataContent === 'string' ? parseMetadata(ctx.metadataContent) : null
  if (!md || !md.valid) return ask()
  // every git op needs a grant; spend them one by one so a once-grant covers one op
  let content = ctx.metadataContent
  const consumed = []
  const date = ctx.date || new Date().toISOString().slice(0, 10)
  for (const op of ops) {
    const m = matchGrant(parseMetadata(content), op.action)
    if (!m.grant) return ask(`${op.matched}: ${m.reason}.`)
    const c = consumeGrant(content, { id: m.grant.id, action: op.action, date })
    if (!c) return ask(`${op.matched}: ${m.grant.id} could not be spent.`)
    content = c.content
    consumed.push({ id: m.grant.id, action: op.action, scope: m.grant.scope, issued: m.grant.issued })
  }
  return { decision: 'allow', reason: allowReason(consumed), consumed: consumed.map(c => ({ id: c.id, action: c.action })), content }
}

function checkBashMetadataWrite(command) {
  if (!METADATA.test(command)) return null
  const redirect = command.match(/>{1,2}\s*["']?(\S*sdlc-metadata\.ya?ml)/)
  if (redirect && isMeta(redirect[1])) {
    return { decision: 'deny', reason: denyReason('Shell redirect into sdlc-metadata.yml') }
  }
  for (const seg of segments(command)) {
    const toks = tokens(seg)
    const cmd = toks[0]
    if (!cmd) continue
    const args = toks.slice(1)
    if (cmd === 'sed' && args.some(t => t.startsWith('-i')) && args.some(isMeta)) {
      return { decision: 'deny', reason: denyReason('In-place sed of sdlc-metadata.yml') }
    }
    if (cmd === 'tee' && args.some(isMeta)) {
      return { decision: 'deny', reason: denyReason('tee into sdlc-metadata.yml') }
    }
    if ((cmd === 'cp' || cmd === 'mv') && args.length > 0 && isMeta(args[args.length - 1])) {
      return { decision: 'deny', reason: denyReason(`${cmd} onto sdlc-metadata.yml`) }
    }
  }
  return null
}

function checkFileEdit(toolName, toolInput) {
  const path = toolInput.file_path ?? toolInput.notebook_path
  if (typeof path !== 'string' || !isMeta(path)) return null
  return { decision: 'deny', reason: denyReason(`Direct ${toolName} of ${path}`) }
}

// decide(hookInput, ctx) → null (no opinion — fail open)
//   | { decision: 'ask'|'deny', reason }
//   | { decision: 'allow', reason, consumed: [{id, action}], content }  — `content` is the
//     metadata with the grant(s) spent; the CLI writes it back, tests inspect it.
// ctx.metadataContent is the target repo's sdlc-metadata.yml (absent → 0.4.1 behaviour).
export function decide(input, ctx = {}) {
  if (!input || typeof input !== 'object') return null
  const tool = input.tool_name
  const toolInput = input.tool_input
  if (!toolInput || typeof toolInput !== 'object') return null
  if (tool === 'Bash' && typeof toolInput.command === 'string') {
    return checkBashMetadataWrite(toolInput.command) ?? checkBashPublish(toolInput.command, ctx || {})
  }
  if (EDIT_TOOLS.has(tool)) return checkFileEdit(tool, toolInput)
  return null
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  // The hook runs in the target repo; its metadata (if any) carries the grants.
  const metaPath = join(typeof input?.cwd === 'string' ? input.cwd : process.cwd(), META_REL)
  const ctx = {}
  try { if (existsSync(metaPath)) ctx.metadataContent = readFileSync(metaPath, 'utf8') } catch { /* fail open */ }
  const d = decide(input, ctx)
  if (!d) return
  if (d.decision === 'allow' && typeof d.content === 'string') {
    // spend the grant deterministically — if this write fails, do not allow
    try { writeFileSync(metaPath, d.content) } catch {
      d.decision = 'ask'
      d.reason = askReason('git') + ' (a grant applied but could not be spent — metadata not writable)'
    }
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason,
    },
  }) + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
