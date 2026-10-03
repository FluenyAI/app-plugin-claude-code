// Feature 0008, option D: in-session coaching, as a Claude Code mod.
//
// The command hooks in hooks.json are the sensor and the only thing that sends
// anything. This module sends nothing: it makes no network, process or file
// call, which `claude plugin validate` shows a reviewer. It reads tool names,
// edited file paths and Bash command text as they pass, reduces them to counts
// in memory, and draws two things from those counts:
//
// - a coaching line under Claude's answer (turn.complete), at most one a turn
// - /flueny-coach, a pane of this session's own counts
//
// Claude Code only. Grok has no mods and keeps the command hooks alone.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { NudgeState, SessionStats } from '../types'
import { EDIT_TOOLS, isTestCommand, needsTests, pickNudge, remember } from './coach-rules'

const PANE = 'flueny-coach'

const EMPTY_STATS: SessionStats = {
  turns: 0,
  filesEdited: 0,
  testRuns: 0,
  failedCommands: 0,
  contextPercent: null,
  shown: { untested: 0, context: 0 },
}

const stats = atom({ plugin: 'flueny', key: 'stats' } as const, EMPTY_STATS)
const nudges = atom({ plugin: 'flueny', key: 'nudges' } as const, {
  lastShownTurn: {},
  isContextArmed: true,
} satisfies NudgeState)

// The one place a path or command is looked at. Returns the edited file path
// for an edit tool, the command for Bash, and nothing for any other tool.
const pathOf = (e: object): string | undefined => {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = input.file_path ?? input.notebook_path

  return typeof path === 'string' ? path : undefined
}

const commandOf = (e: object): string | undefined => {
  const command = (e as { command?: unknown }).command

  return typeof command === 'string' ? command : undefined
}

export const register: Register = (on, options) => {
  const isNudging = options.nudges !== false

  // This turn's files changed after its last test run. Paths stay in this set
  // for one turn and are only ever counted.
  let untested = new Set<string>()
  // Every file edited this session, counted for the pane.
  const edited = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Show what Flueny sees in this session. Nothing in it leaves this machine.',
    })

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await $.ui.open({ id: PANE, title: 'Flueny coach' })

    return { text: 'Flueny coach pane opened.' }
  })

  on('turn.start', ($, e, next) => {
    untested = new Set()

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      if (e.tool === 'Bash' && ran.isError === true) {
        await update($, stats, s => ({ ...s, failedCommands: s.failedCommands + 1 }))
      }

      return ran
    }

    if (EDIT_TOOLS.has(e.tool)) {
      const path = pathOf(e)
      if (path !== undefined) {
        edited.add(path)
        if (needsTests(path)) {
          untested.add(path)
        }
        await update($, stats, s => ({ ...s, filesEdited: edited.size }))
      }
    } else if (e.tool === 'Bash') {
      const command = commandOf(e)
      if (command !== undefined && isTestCommand(command)) {
        untested = new Set()
        await update($, stats, s => ({ ...s, testRuns: s.testRuns + 1 }))
      }
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's turns and an interrupted or failed turn get no line.
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return done
    }

    // A host that cannot measure the context still gets the other lines.
    const contextPercent = await $.session.usage().then(
      usage => usage.context.percent ?? null,
      () => null,
    )
    const turn = (await read($, stats)).turns + 1
    const facts = { turn, untestedFiles: untested.size, contextPercent }

    const memory = await read($, nudges)
    const nudge = isNudging ? pickNudge(facts, memory) : null
    await update($, nudges, () => remember(memory, facts, nudge))
    await update($, stats, s => ({
      ...s,
      turns: turn,
      contextPercent,
      shown: nudge ? { ...s.shown, [nudge.kind]: s.shown[nudge.kind] + 1 } : s.shown,
    }))

    if (nudge === null) {
      return done
    }
    // Another mod may already have put a line under this answer: keep it.
    const text = done.text === e.answer ? nudge.text : `${done.text}\n${nudge.text}`

    return { ...done, text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, stats)
    const row = (label: string, value: string) => (
      <Box key={label}>
        <Box width={20}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text>{value}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>This session</Text>
          {row('Turns', String(s.turns))}
          {row('Files edited', String(s.filesEdited))}
          {row('Test runs', String(s.testRuns))}
          {row('Failed commands', String(s.failedCommands))}
          {row('Context', s.contextPercent === null ? 'not measured yet' : `${s.contextPercent}% full`)}
        </Box>
        <Box flexDirection="column">
          <Text bold>Coaching lines shown</Text>
          {row('Untested changes', String(s.shown.untested))}
          {row('Context nearly full', String(s.shown.context))}
          <Text dimColor>
            {isNudging
              ? 'Coaching lines are on. Turn them off in /config.'
              : 'Coaching lines are off. Turn them on in /config.'}
          </Text>
        </Box>
        <Text dimColor>
          Nothing in this pane leaves this machine. /flueny:status shows what Flueny sends.
        </Text>
      </Box>
    )
  })
}
