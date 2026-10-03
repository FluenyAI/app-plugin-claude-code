// The mod's type contract (feature 0008, option D, and 0137): the values it
// keeps in $.state, under the plugin's name.

export type NudgeKind = 'untested' | 'context' | 'guideline'

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
}

export type NudgeState = {
  lastShownTurn: Partial<Record<NudgeKind, number>>
  isContextArmed: boolean
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
