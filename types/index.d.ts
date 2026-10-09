// The mod's type contract (feature 0008, option D, and 0137): the values it
// keeps in $.state, under the plugin's name.

export type NudgeKind = 'untested' | 'context' | 'guideline' | 'secrets'

// Feature 0154. A shell command's kind and a secrets file's kind, as the binary
// names them (src/extract.rs), worked out again in the mod by hooks/shell-kinds.ts.
export type CommandKind =
  | 'test'
  | 'git'
  | 'build'
  | 'install'
  | 'run'
  | 'network'
  | 'search'
  | 'inspect'
  | 'files'
  | 'other'

export type SecretsKind = 'env' | 'key'

export type SecretsAction = 'read' | 'copied or moved' | 'edited' | 'touched'

// The first secrets file this session touched, for the coach's one-time line.
// Only the basename, and it stays in this session's state on this machine.
export type SecretsTouch = { kind: SecretsKind; name: string; action: SecretsAction }

export type Nudge = { kind: NudgeKind; text: string }

// This session's own counts, drawn by /flueny-coach. Derived on the machine
// and never sent.
export type SessionStats = {
  turns: number
  filesEdited: number
  testRuns: number
  failedCommands: number
  contextPercent: number | null
  shown: Record<NudgeKind, number>
  // Feature 0154. Tool uses that touched a secrets file, and shell commands by kind.
  secretsFilesTouched: number
  shellKinds: Partial<Record<CommandKind, number>>
}

export type NudgeState = {
  lastShownTurn: Partial<Record<NudgeKind, number>>
  isContextArmed: boolean
  // Feature 0154. Set on the first touch, kept after its line has shown.
  firstSecretsTouch?: SecretsTouch | null
}

// Feature 0137. The org's published digest, as the binary wrote it to
// guidelines.json after the handshake.
export type GuidelineSection = { pathClass: string; title: string; points: string[] }

export type TeamGuidelines = {
  etag: string
  publishedAt: string
  summary: string
  sections: GuidelineSection[]
  // pathClass -> glob patterns, first match wins in this order.
  pathClassifier: [string, string[]][]
}

declare module 'claude-code' {
  interface PluginState {
    flueny: { stats: SessionStats; nudges: NudgeState; guidelines: TeamGuidelines | null }
  }
}
