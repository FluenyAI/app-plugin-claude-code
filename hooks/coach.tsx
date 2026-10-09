// Feature 0008, option D: in-session coaching, as a Claude Code mod.
//
// The command hooks in hooks.json are the sensor and the only thing that sends
// anything. This module sends nothing: it makes no network or process call, and
// its one file call reads guidelines.json, which the binary wrote. `claude
// plugin validate` shows a reviewer exactly that. It reads tool names, edited
// file paths and Bash command text as they pass, reduces them to counts and
// path classes in memory, and draws from those:
//
// - a coaching line under Claude's answer (turn.complete), at most one a turn
// - /flueny-coach, a pane of this session's own counts
// - feature 0154: what kinds of shell command Claude ran, how many tool uses
//   touched a secrets file (.env, a private key), and a one-time line the
//   first time one does, decided by the binary's own rules (shell-kinds.ts)
// - feature 0137: the team's published guidelines as context for Claude, a
//   guideline line when a turn touched code one covers, and /flueny-guidelines
//
// Claude Code only. Grok has no mods and keeps the command hooks alone.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EngineInterface } from 'claude-code'
import type { NudgeState, SessionStats, TeamGuidelines } from '../types'
import { EDIT_TOOLS, isTestCommand, needsTests, pickNudge, remember } from './coach-rules'
import { FLUENY_MARK_PNG } from './logo'
import { commandKind, secretsActionOf, secretsFileOf, topShellKinds } from './shell-kinds'
import {
  CONTEXT_BLOCK,
  GUIDELINES_FILE,
  classifyPath,
  configDir,
  contextText,
  parseGuidelines,
  relativeTo,
} from './guidelines'

const PANE = 'flueny-coach'
const GUIDELINES_PANE = 'flueny-guidelines'

const EMPTY_STATS: SessionStats = {
  turns: 0,
  filesEdited: 0,
  testRuns: 0,
  failedCommands: 0,
  contextPercent: null,
  shown: { untested: 0, context: 0, guideline: 0, secrets: 0 },
  secretsFilesTouched: 0,
  shellKinds: {},
}

// Session state written by an older version of this mod lacks the newer
// counts. A reload keeps the state, so fill the gaps rather than count on NaN.
const complete = (s: SessionStats): SessionStats => ({
  ...EMPTY_STATS,
  ...s,
  shown: { ...EMPTY_STATS.shown, ...s.shown },
})

const stats = atom({ plugin: 'flueny', key: 'stats' } as const, EMPTY_STATS)
const nudges = atom({ plugin: 'flueny', key: 'nudges' } as const, {
  lastShownTurn: {},
  isContextArmed: true,
} satisfies NudgeState)
const guidelines = atom({ plugin: 'flueny', key: 'guidelines' } as const, null as TeamGuidelines | null)

// Reads what the binary's last handshake left. A missing or malformed file is
// no guidelines: the policy is off, nothing is published, or Flueny is not
// connected on this machine.
const loadGuidelines = async ($: EngineInterface): Promise<TeamGuidelines | null> => {
  // Each name spelled out, so `claude plugin validate` lists what is read.
  const env: Record<string, string | undefined> = {
    FLUENY_CONFIG_DIR: await $.env.get('FLUENY_CONFIG_DIR'),
    XDG_CONFIG_HOME: await $.env.get('XDG_CONFIG_HOME'),
    HOME: await $.env.get('HOME'),
    USERPROFILE: await $.env.get('USERPROFILE'),
  }
  const dir = configDir(name => env[name])
  if (dir === null) {
    return null
  }
  const text = await $.fs.read(`${dir}/${GUIDELINES_FILE}`).then(
    t => (typeof t === 'string' ? t : null),
    () => null,
  )

  return text === null ? null : parseGuidelines(text)
}

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

// Feature 0154. Counts a shell command by kind and a tool use that touched a
// secrets file. The command and path are matched here and dropped; only the
// first secrets file's basename is kept, for the coach's own line.
const noteShellAndSecrets = async ($: EngineInterface, e: { tool: string }) => {
  const input = e as unknown as Record<string, unknown>
  const command = e.tool === 'Bash' ? commandOf(e) : undefined
  if (command !== undefined) {
    const kind = commandKind(command)
    await update($, stats, raw => {
      const s = complete(raw)

      return { ...s, shellKinds: { ...s.shellKinds, [kind]: (s.shellKinds[kind] ?? 0) + 1 } }
    })
  }
  const hit = secretsFileOf(e.tool, input)
  if (hit === null) {
    return
  }
  await update($, stats, raw => {
    const s = complete(raw)

    return { ...s, secretsFilesTouched: s.secretsFilesTouched + 1 }
  })
  const action = secretsActionOf(e.tool, commandOf(e))
  await update($, nudges, m => (m.firstSecretsTouch ? m : { ...m, firstSecretsTouch: { ...hit, action } }))
}

export const register: Register = (on, options) => {
  const isNudging = options.nudges !== false

  // This turn's files changed after its last test run. Paths stay in this set
  // for one turn and are only ever counted.
  let untested = new Set<string>()
  // Every file edited this session, counted for the pane.
  const edited = new Set<string>()
  // Path classes this turn's edits touched, first touch first. Only the class
  // label is kept; the path is matched and dropped.
  let touched: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Show what Flueny sees in this session. Nothing in it leaves this machine.',
    })
    await $.command.register({
      name: GUIDELINES_PANE,
      description: "Show your team's engineering guidelines, as Claude receives them.",
    })
    const loaded = await loadGuidelines($)
    await update($, guidelines, () => loaded)

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await $.ui.open({ id: PANE, title: 'Flueny coach' })

    return { text: 'Flueny coach pane opened.' }
  })

  on('command.run', { command: GUIDELINES_PANE }, async $ => {
    await $.ui.open({ id: GUIDELINES_PANE, title: 'Team guidelines' })

    return { text: 'Team guidelines pane opened.' }
  })

  // Once per conversation. Read again here rather than trusted from
  // session.start, because the binary's SessionStart hook for /clear may have
  // just refreshed the file.
  on('prompt.context', async ($, e, next) => {
    const done = await next(e)
    const current = await loadGuidelines($)
    await update($, guidelines, () => current)
    if (current === null || done.blocks.some(b => b.name === CONTEXT_BLOCK)) {
      return done
    }

    return { ...done, blocks: [...done.blocks, { name: CONTEXT_BLOCK, text: contextText(current) }] }
  })

  on('turn.start', ($, e, next) => {
    untested = new Set()
    touched = []

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      await noteShellAndSecrets($, e)
    }
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
        const g = await read($, guidelines)
        if (g !== null) {
          const pathClass = classifyPath(g.pathClassifier, relativeTo(await $.session.root(), path))
          if (pathClass !== null && !touched.includes(pathClass)) {
            touched.push(pathClass)
          }
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
    const memory = await read($, nudges)
    const facts = {
      turn,
      untestedFiles: untested.size,
      contextPercent,
      touchedClasses: touched,
      guidelines: await read($, guidelines),
      secretsTouch: memory.firstSecretsTouch ?? null,
    }

    const nudge = isNudging ? pickNudge(facts, memory) : null
    await update($, nudges, () => remember(memory, facts, nudge))
    await update($, stats, raw => {
      const s = complete(raw)

      return {
      ...s,
      turns: turn,
      contextPercent,
      shown: nudge ? { ...s.shown, [nudge.kind]: s.shown[nudge.kind] + 1 } : s.shown,
      }
    })

    if (nudge === null) {
      return done
    }
    // Another mod may already have put a line under this answer: keep it.
    const text = done.text === e.answer ? nudge.text : `${done.text}\n${nudge.text}`

    return { ...done, text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // Feature 0154. The mark is pixels only on the terminal, the one surface
    // whose table has an Image; anywhere else, and in a terminal that cannot
    // draw pictures (Image's alt), it is the dim wordmark.
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : undefined
    const s = complete(await read($, stats))
    const row = (label: string, value: string, isAlarm = false) => (
      <Box key={label}>
        <Box width={24}>
          <Text dimColor>{label}</Text>
        </Box>
        {isAlarm ? (
          <Text color="error" bold>
            {value}
          </Text>
        ) : (
          <Text>{value}</Text>
        )}
      </Box>
    )
    const ran = topShellKinds(s.shellKinds)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>This session</Text>
          {row('Turns', String(s.turns))}
          {row('Files edited', String(s.filesEdited))}
          {row('Test runs', String(s.testRuns))}
          {row('Failed commands', String(s.failedCommands))}
          {row('What Claude ran', ran === '' ? 'no shell commands yet' : ran)}
          {row('Secrets files touched', String(s.secretsFilesTouched), s.secretsFilesTouched > 0)}
          {row('Context', s.contextPercent === null ? 'not measured yet' : `${s.contextPercent}% full`)}
        </Box>
        <Box flexDirection="column">
          <Text bold>Coaching lines shown</Text>
          {row('Untested changes', String(s.shown.untested))}
          {row('Context nearly full', String(s.shown.context))}
          {row('Team guideline', String(s.shown.guideline))}
          {row('Secrets file', String(s.shown.secrets))}
          <Text dimColor>
            {isNudging
              ? 'Coaching lines are on. Turn them off in /config.'
              : 'Coaching lines are off. Turn them on in /config.'}
          </Text>
        </Box>
        <Text dimColor>
          Nothing in this pane leaves this machine. /flueny:status shows what Flueny sends.
        </Text>
        <Box key="mark" gap={1} alignItems="center">
          {Image ? <Image key="flueny-mark" source={{ png: FLUENY_MARK_PNG }} columns={4} rows={2} alt="Flueny" /> : null}
          <Text dimColor>{Image ? 'Flueny coach' : 'Flueny'}</Text>
        </Box>
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: GUIDELINES_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const g = await read($, guidelines)
    if (g === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No team guidelines in this session.</Text>
          <Text dimColor>
            Your organisation has not published any, has turned them off for you, or this machine is
            not connected to Flueny. /flueny:status says which.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Published {g.publishedAt.slice(0, 10)}. Claude receives exactly this at the start of each
          conversation.
        </Text>
        <Text>{g.summary}</Text>
        {g.sections.map(section => (
          <Box key={section.pathClass} flexDirection="column">
            <Text bold>
              {section.title} <Text dimColor>({section.pathClass === 'general' ? 'all code' : `${section.pathClass} code`})</Text>
            </Text>
            {section.points.map((point, i) => (
              <Text key={String(i)}>- {point}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
