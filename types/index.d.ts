// The mod's type contract (feature 0008, option D): the values it keeps in
// $.state, under the plugin's name.

export type NudgeKind = 'untested' | 'context'

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

declare module 'claude-code' {
  interface PluginState {
    flueny: { stats: SessionStats; nudges: NudgeState }
  }
}
