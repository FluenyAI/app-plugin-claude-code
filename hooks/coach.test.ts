import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { isTestCommand, needsTests, pickNudge, remember } from './coach-rules'

// Each test's own hooks stand for the engine: they answer every tool call and
// report the context fill the session would.
const engine = (on: On, percent = 10) => {
  on('tool.call', (_$, e) =>
    e.tool === 'Bash' && String((e as { command?: unknown }).command).includes('false')
      ? { isError: true, result: null, text: 'Exit code 1' }
      : { result: {} },
  )
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

const turn = async ($: Engine, run: () => Promise<unknown>) => {
  const turnId = `t-${Math.random()}`
  await $.turn.start({ text: 'do the work', turnId })
  await run()

  return $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

describe('coach rules', () => {
  test('test commands match the conservative list and nothing else', () => {
    for (const command of ['npm test', 'pnpm run test', 'npx vitest run', 'cargo test --all', 'go test ./...', 'make test']) {
      expect(isTestCommand(command)).toBe(true)
    }
    for (const command of ['npm run build', 'ls tests/', 'cat src/test.rs', 'git status']) {
      expect(isTestCommand(command)).toBe(false)
    }
  })

  test('prose edits never count toward untested changes', () => {
    expect(needsTests('README.md')).toBe(false)
    expect(needsTests('docs/guide/setup.ts')).toBe(false)
    expect(needsTests('src/billing/charge.ts')).toBe(true)
  })

  test('a shown line goes quiet for five turns, and context re-arms only after dropping', () => {
    const fresh = { lastShownTurn: {}, isContextArmed: true }
    const untested = { turn: 1, untestedFiles: 3, contextPercent: 10 }
    const first = pickNudge(untested, fresh)
    expect(first?.kind).toBe('untested')
    const after = remember(fresh, untested, first)
    expect(pickNudge({ ...untested, turn: 5 }, after)).toBe(null)
    expect(pickNudge({ ...untested, turn: 6 }, after)?.kind).toBe('untested')

    const full = { turn: 1, untestedFiles: 0, contextPercent: 85 }
    const shown = remember(fresh, full, pickNudge(full, fresh))
    expect(pickNudge({ ...full, turn: 20 }, shown)).toBe(null)
    const cleared = remember(shown, { ...full, turn: 21, contextPercent: 5 }, null)
    expect(pickNudge({ ...full, turn: 22 }, cleared)?.kind).toBe('context')
  })
})

describe('coaching line under the answer', () => {
  test('three changed files with no test run show the line', async ($, on) => {
    engine(on)
    const done = await turn($, async () => {
      for (const file_path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
        await $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string: 'y' })
      }
    })
    expect(done.text).toContain('3 files changed this turn')
  })

  test('a test run after the last change keeps it quiet', async ($, on) => {
    engine(on)
    const done = await turn($, async () => {
      for (const file_path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
        await $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string: 'y' })
      }
      await $.tool.call({ tool: 'Bash', command: 'npm test' })
    })
    expect(done.text).toBe('Done.')
  })

  test('a nearly full context shows its line', async ($, on) => {
    engine(on, 86)
    const done = await turn($, async () => {})
    expect(done.text).toContain('context is 86% full')
  })

  test('nudges can be turned off', { options: { nudges: false } }, async ($, on) => {
    engine(on, 95)
    const done = await turn($, async () => {
      for (const file_path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
        await $.tool.call({ tool: 'Write', file_path, content: 'x' })
      }
    })
    expect(done.text).toBe('Done.')
  })
})

describe('/flueny-coach pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws this session's counts on ${surface}`, async ($, on) => {
      engine(on)
      await turn($, async () => {
        await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })
        await $.tool.call({ tool: 'Bash', command: 'cargo test' })
        await $.tool.call({ tool: 'Bash', command: 'false' })
      })
      const ui = await $.ui.mount({
        plugin: 'flueny',
        surface,
        component: 'Pane',
        requestId: 'flueny-coach',
        props: {
          title: 'Flueny coach',
          isFocused: true,
          bodyColumns: 80,
          placement: 'dock',
          scroll: { bodyRows: 30 },
          view: undefined,
        } as never,
      })
      expect(await ui.find({ type: 'Text', text: 'Nothing in this pane leaves this machine' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: '10% full' })).toBeTruthy()
    })
  }
})
