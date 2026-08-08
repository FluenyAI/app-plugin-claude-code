import { CLIENT_VERSION, currentToken, sessionStart } from './api.ts'
import { findRepo } from './git.ts'
import { repoIdFor } from './repo-id.ts'
import { readBundle, readSession, writeBundle, writeSession } from './store.ts'
import type { SessionState } from './store.ts'
import type { AgentId, PolicyBundle, SessionStartResponse } from './types.ts'

// The SessionStart handshake (CEO decision 4A). The client runs on machines
// Flueny does not control, so the server states on every session whether it
// should run at all, what it is allowed to look at, and what it is capable of.
//
// Three things make the client inert, and all three mean the same thing on the
// wire, which is nothing at all:
//
//   no credential      nobody has connected this machine yet
//   kill switch        the org turned the surface off (CEO decision 4A)
//   repo not allowed   CEO decision 14A, and it is FAIL CLOSED: an empty
//                      allowlist matches nothing, so a misconfigured org leaks
//                      no repository rather than every repository
//
// Inert is not an error. A developer who has not connected Flueny, and a
// developer whose org killed it, both get an editor that behaves exactly as if
// this client were not installed.

export const AGENT: AgentId = 'claude-code'

export interface BeginResult {
  state: SessionState
  handshake: SessionStartResponse | null
  // Which branch the bundle cache took, so the CLI can report it and
  // test/handshake.test.ts can assert it.
  bundleSource: 'server' | 'cache' | 'refetched' | 'none'
}

export async function beginSession(opts: {
  sessionId: string
  cwd: string
}): Promise<BeginResult> {
  const repo = findRepo(opts.cwd)
  const repoId = repo?.remote ? repoIdFor(repo.remote) : null
  const base: SessionState = {
    sessionId: opts.sessionId,
    agent: AGENT,
    startedAt: Date.now(),
    inert: true,
    inertReason: null,
    killSwitch: false,
    dryRun: false,
    dryRunEndsAt: null,
    repoId,
    repoRoot: repo?.root ?? null,
    toolUses: 0,
    subagents: 0,
    pendingEdits: [],
    testsRanThisTurn: false,
    seenToolUseIds: [],
    transcriptOffset: 0,
    eventSeq: 0,
  }

  const creds = await currentToken()
  if (!creds) {
    return finish({ ...base, inertReason: 'not connected: run flueny login' }, null, 'none')
  }

  const cached = readBundle()
  let res = await sessionStart(creds.apiUrl, creds.accessToken, {
    agent: AGENT,
    sessionId: opts.sessionId,
    clientVersion: CLIENT_VERSION,
    bundleEtag: cached?.etag ?? null,
  })
  let bundleSource: BeginResult['bundleSource'] = 'none'

  if (res.status !== 200 || !res.body) {
    // A handshake that did not answer is not a reason to guess. Inert, quietly,
    // and the next session tries again.
    return finish({ ...base, inertReason: `handshake unavailable (${res.status})` }, null, 'none')
  }

  let handshake = res.body
  let bundle: PolicyBundle | null = handshake.bundle

  if (bundle) {
    writeBundle(bundle)
    bundleSource = 'server'
  } else if (cached) {
    // The steady state, and the whole point of CEO decision 25A: a session start
    // costs one small response once the client already holds the bundle.
    bundle = cached
    bundleSource = 'cache'
  } else {
    // Null bundle with nothing cached should not happen, but it is exactly the
    // shape a stale or hand-edited etag produces, and the failure is silent:
    // no classifier means every pathClass is null and every scorer starves. So
    // ask once more with no etag rather than run blind.
    res = await sessionStart(creds.apiUrl, creds.accessToken, {
      agent: AGENT,
      sessionId: opts.sessionId,
      clientVersion: CLIENT_VERSION,
      bundleEtag: null,
    })
    if (res.status === 200 && res.body?.bundle) {
      handshake = res.body
      bundle = res.body.bundle
      writeBundle(bundle)
      bundleSource = 'refetched'
    }
  }

  const state: SessionState = {
    ...base,
    killSwitch: handshake.killSwitch,
    dryRun: handshake.dryRun,
    dryRunEndsAt: handshake.dryRunEndsAt,
  }

  if (handshake.killSwitch) {
    return finish({ ...state, inertReason: 'kill switch is on for this organisation' }, handshake, bundleSource)
  }
  if (!repoId) {
    return finish({ ...state, inertReason: 'no git remote here, so this is not an org repository' }, handshake, bundleSource)
  }
  // Fail closed. `includes` on an empty array is false, which is the entire
  // guarantee: an org that registered nothing receives nothing.
  if (!handshake.repoAllowlist.includes(repoId)) {
    return finish({ ...state, inertReason: 'this repository is not on the org allowlist' }, handshake, bundleSource)
  }
  if (!bundle) {
    return finish({ ...state, inertReason: 'no path classifier available' }, handshake, bundleSource)
  }

  return finish({ ...state, inert: false, inertReason: null }, handshake, bundleSource)
}

function finish(state: SessionState, handshake: SessionStartResponse | null, bundleSource: BeginResult['bundleSource']): BeginResult {
  writeSession(state)
  return { state, handshake, bundleSource }
}

// Hooks fire in whatever order Claude Code runs them, and the plugin can be
// installed halfway through a session, so every later hook has to cope with no
// state on disk. It handshakes rather than assuming, because assuming means
// either sending from a repository nobody allowed or silently sending nothing.
export async function ensureSession(sessionId: string, cwd: string): Promise<SessionState> {
  const existing = readSession(sessionId)
  if (existing) return existing
  return (await beginSession({ sessionId, cwd })).state
}

export function classifierFor(): Record<string, string[]> {
  return readBundle()?.pathClassifier ?? {}
}
