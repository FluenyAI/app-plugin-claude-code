// Feature 0008, option D. The rules behind the coaching line, kept apart from
// the hooks so they read and test as plain functions.
//
// Everything here runs on the machine and returns a short label or a number.
// The command text and file paths it is handed are matched and dropped: none of
// it is stored, drawn or sent.

import type { Nudge, NudgeKind, SecretsTouch, TeamGuidelines } from '../types'

// Mirrors TEST_COMMAND in src/extract.rs. Deliberately conservative for the
// same reason: a false positive tells someone their edits were tested when
// they were not. Change both together.
const TEST_COMMAND = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?tests?\b`,
    String.raw`\bnpx?\s+(jest|vitest|mocha|ava|playwright|cypress)\b`,
    String.raw`\b(jest|vitest|pytest|tox|rspec|phpunit)\b`,
    String.raw`\bgo\s+test\b`,
    String.raw`\bcargo\s+test\b`,
    String.raw`\bmvn\s+(\S+\s+)*test\b`,
    String.raw`\bgradle(w)?\s+(\S+\s+)*test\b`,
    String.raw`\bdotnet\s+test\b`,
    String.raw`\bnode\s+--test\b`,
    String.raw`\bmake\s+test\b`,
  ].join('|'),
  'i',
)

export const isTestCommand = (command: string): boolean => TEST_COMMAND.test(command)

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// Prose needs no test run, so an edit to one never counts toward the nudge.
const PROSE = /(\.(md|mdx|markdown|txt|rst|adoc)$)|(^|\/)docs?\//i

export const needsTests = (path: string): boolean => !PROSE.test(path)

// Files changed after the last test run in a turn, before the line shows.
export const UNTESTED_FILES_MIN = 3
// Context fill, in percent, that shows the line, and the fill it has to drop
// back under (a /clear or a compaction) before it can show again.
export const CONTEXT_FULL_PERCENT = 80
export const CONTEXT_REARM_PERCENT = 50
// The same kind of line is not shown again within this many turns.
export const QUIET_TURNS = 5

export type TurnFacts = {
  turn: number
  untestedFiles: number
  contextPercent: number | null
  // Path classes the turn's edits touched, in the order first touched.
  touchedClasses?: readonly string[]
  guidelines?: TeamGuidelines | null
  // Feature 0154. The first secrets file this session touched, if any.
  secretsTouch?: SecretsTouch | null
}

export type NudgeMemory = {
  lastShownTurn: Partial<Record<NudgeKind, number>>
  isContextArmed: boolean
  firstSecretsTouch?: SecretsTouch | null
}

const isQuiet = (memory: NudgeMemory, kind: NudgeKind, turn: number): boolean => {
  const last = memory.lastShownTurn[kind]

  return last !== undefined && turn - last < QUIET_TURNS
}

// At most one line a turn. A secrets file (feature 0154) comes first and shows
// once a session: it is the one line about something that may already have
// left the developer's control. Untested edits come next: they are about the
// work that was just done, where a full context is about the next task. A team
// guideline (feature 0137) is the gentlest, so it comes last.
export const pickNudge = (facts: TurnFacts, memory: NudgeMemory): Nudge | null => {
  const secrets = facts.secretsTouch
  if (secrets && memory.lastShownTurn.secrets === undefined) {
    const instead = secrets.kind === 'env' ? 'Point it at .env.example instead.' : 'Give it a throwaway key instead.'

    return {
      kind: 'secrets',
      text:
        `Flueny: Claude ${secrets.action} ${secrets.name} this session. Secrets in the agent's context can ` +
        `end up in logs, commits or prompts. ${instead}`,
    }
  }

  if (facts.untestedFiles >= UNTESTED_FILES_MIN && !isQuiet(memory, 'untested', facts.turn)) {
    return {
      kind: 'untested',
      text:
        `Flueny: ${facts.untestedFiles} files changed this turn with no test run after the last ` +
        'change. Ask Claude to run the tests before you accept the work.',
    }
  }

  const percent = facts.contextPercent
  if (
    percent !== null &&
    percent >= CONTEXT_FULL_PERCENT &&
    memory.isContextArmed &&
    !isQuiet(memory, 'context', facts.turn)
  ) {
    return {
      kind: 'context',
      text:
        `Flueny: context is ${percent}% full. Start the next task in a fresh session with ` +
        '/clear, or /compact first, so earlier work stops crowding out the new instructions.',
    }
  }

  const section = guidelineFor(facts)
  if (section !== null && !isQuiet(memory, 'guideline', facts.turn)) {
    return {
      kind: 'guideline',
      text:
        `Flueny: this turn changed ${section.pathClass} code. Team guideline: ${section.point} ` +
        '/flueny-guidelines has the rest.',
    }
  }

  return null
}

// The first touched path class that has a section. `general` is never a path
// class, so a general section only reaches Claude's context, not this line.
const guidelineFor = (facts: TurnFacts): { pathClass: string; point: string } | null => {
  const sections = facts.guidelines?.sections ?? []
  const touched = facts.touchedClasses ?? []
  for (const pathClass of touched) {
    const point = sections.find(s => s.pathClass === pathClass)?.points[0]
    if (point !== undefined) {
      return { pathClass, point: withStop(point) }
    }
  }

  return null
}

const withStop = (point: string): string => (/[.!?]$/.test(point.trim()) ? point.trim() : `${point.trim()}.`)

export const remember = (memory: NudgeMemory, facts: TurnFacts, shown: Nudge | null): NudgeMemory => {
  const percent = facts.contextPercent
  const isContextArmed =
    shown?.kind === 'context'
      ? false
      : percent !== null && percent < CONTEXT_REARM_PERCENT
        ? true
        : memory.isContextArmed

  return {
    ...memory,
    lastShownTurn: shown ? { ...memory.lastShownTurn, [shown.kind]: facts.turn } : memory.lastShownTurn,
    isContextArmed,
  }
}
