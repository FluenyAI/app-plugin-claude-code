import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { pickNudge } from './coach-rules'
import { classifyPath, configDir, contextText, globMatch, parseGuidelines, relativeTo } from './guidelines'

// The bundle's classifier as the backend builds it, in its order (the same
// fixture as test_classifier in src/classify.rs).
const CLASSIFIER = {
  tests: ['**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**', 'test/**'],
  auth: ['**/auth/**', '**/*auth*', '**/session*', '**/*jwt*', '**/*passkey*'],
  security: ['**/crypto/**', '**/*secret*', '**/*credential*', '**/security/**'],
  payments: ['**/billing/**', '**/payments/**', '**/*stripe*', '**/*invoice*'],
  infra: ['**/Dockerfile*', '**/docker-compose*.yml', '**/*.tf', '.github/workflows/**', 'deploy/**', 'k8s/**'],
  migrations: ['**/migrations/**'],
  config: ['**/*.env*', '**/*.config.*', '**/*.yaml', '**/*.yml'],
  docs: ['**/*.md', 'docs/**'],
  frontend: ['**/*.tsx', '**/components/**', '**/styles/**'],
  backend: ['**/*.ts', '**/*.py', '**/*.go', '**/*.rs', 'src/**'],
}

const FILE = {
  etag: 'g-1',
  publishedAt: '2026-10-03T10:00:00.000Z',
  summary: 'Small PRs. Tests with every change.',
  sections: [
    { pathClass: 'general', title: 'Everywhere', points: ['Prefer boring code.'] },
    { pathClass: 'auth', title: 'Authentication', points: ['Never log tokens', 'Use the session guard.'] },
  ],
  pathClassifier: CLASSIFIER,
}

const parsed = () => {
  const g = parseGuidelines(JSON.stringify(FILE))
  if (g === null) {
    throw new Error('fixture did not parse')
  }

  return g
}

describe('guidelines file', () => {
  test('classifies paths exactly as src/classify.rs does', () => {
    const classifier = parsed().pathClassifier
    const cases: [string, string | null][] = [
      ['src/integrations/coding/coding.spec.ts', 'tests'],
      ['test/e2e/login.ts', 'tests'],
      ['src/auth/jwt.strategy.ts', 'auth'],
      ['src/billing/invoice.ts', 'payments'],
      ['deploy/k8s.yaml', 'infra'],
      ['src/database/migrations/1721200000000-Coding.ts', 'migrations'],
      ['README.md', 'docs'],
      ['docs/architecture.md', 'docs'],
      ['src/components/button.tsx', 'frontend'],
      ['src/main.ts', 'backend'],
      ['src/auth/auth.service.spec.ts', 'tests'],
      ['LICENSE', null],
    ]
    for (const [path, expected] of cases) {
      expect(classifyPath(classifier, path)).toBe(expected)
    }
    expect(globMatch('**/*.md', 'README.md')).toBe(true)
    expect(globMatch('src/*', 'src/a/b.ts')).toBe(false)
  })

  test('paths are made repo relative before matching', () => {
    expect(relativeTo('/work/repo', '/work/repo/src/auth/login.ts')).toBe('src/auth/login.ts')
    expect(relativeTo('C:\\work\\repo', 'C:\\work\\repo\\docs\\a.md')).toBe('docs/a.md')
    expect(relativeTo('/work/repo', '/elsewhere/x.ts')).toBe('elsewhere/x.ts')
  })

  test('a malformed file reads as no guidelines', () => {
    expect(parseGuidelines('not json')).toBe(null)
    expect(parseGuidelines(JSON.stringify({ ...FILE, summary: 42 }))).toBe(null)
    expect(parseGuidelines(JSON.stringify({ ...FILE, sections: [{ pathClass: 'auth' }] }))).toBe(null)
  })

  test('the config dir mirrors the binary', () => {
    const env = (vars: Record<string, string>) => (name: string) => vars[name]
    expect(configDir(env({ FLUENY_CONFIG_DIR: '/x', HOME: '/h' }))).toBe('/x')
    expect(configDir(env({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }))).toBe('/xdg/flueny')
    expect(configDir(env({ HOME: '/h' }))).toBe('/h/.config/flueny')
    expect(configDir(env({ USERPROFILE: 'C:/Users/me' }))).toBe('C:/Users/me/.config/flueny')
    expect(configDir(env({}))).toBe(null)
  })

  test('the context block carries the summary and every point', () => {
    const text = contextText(parsed())
    expect(text).toContain('Small PRs. Tests with every change.')
    expect(text).toContain('## Authentication (auth code)')
    expect(text).toContain('- Use the session guard.')
    expect(text).toContain('## Everywhere (all code)')
  })

  test('the guideline line comes last and names the first touched class with a section', () => {
    const memory = { lastShownTurn: {}, isContextArmed: true }
    const facts = {
      turn: 1,
      untestedFiles: 0,
      contextPercent: 10,
      touchedClasses: ['backend', 'auth'],
      guidelines: parsed(),
    }
    expect(pickNudge(facts, memory)?.text).toBe(
      'Flueny: this turn changed auth code. Team guideline: Never log tokens. /flueny-guidelines has the rest.',
    )
    expect(pickNudge({ ...facts, untestedFiles: 3 }, memory)?.kind).toBe('untested')
    expect(pickNudge({ ...facts, touchedClasses: ['backend'] }, memory)).toBe(null)
    expect(pickNudge(facts, { ...memory, lastShownTurn: { guideline: 0 } })).toBe(null)
  })
})

// The engine beneath the mod: the environment, the file the binary wrote, the
// project root, and the events the mod's hooks pass on.
const engine = (on: On, file: string | null) => {
  on('env.get', (_$, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/dev' : undefined }))
  on('fs.read', (_$, e) =>
    file !== null && String((e as { path?: unknown }).path) === '/home/dev/.config/flueny/guidelines.json'
      ? { value: file }
      : { deny: 'ENOENT' },
  )
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

const editAuth = async ($: Engine) => {
  await $.turn.start({ text: 'fix login', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/repo/src/auth/login.ts', old_string: 'a', new_string: 'b' })

  return $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
}

describe('team guidelines in the session', () => {
  test('Claude gets the guidelines as context, once', async ($, on) => {
    engine(on, JSON.stringify(FILE))
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
    const added = blocks.filter(b => b.name === 'teamGuidelines')
    expect(added.length).toBe(1)
    expect(added[0]?.text).toContain('Never log tokens')
  })

  test('no file means no context block and no guideline line', async ($, on) => {
    engine(on, null)
    const { blocks } = await $.prompt.context({ blocks: [] })
    expect(blocks.length).toBe(0)
    expect((await editAuth($)).text).toBe('Done.')
  })

  test('an edit to auth code shows the auth guideline under the answer', async ($, on) => {
    engine(on, JSON.stringify(FILE))
    await $.prompt.context({ blocks: [] })
    expect((await editAuth($)).text).toContain('this turn changed auth code. Team guideline: Never log tokens.')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const props = {
      title: 'Team guidelines',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { bodyRows: 30 },
      view: undefined,
    } as never

    test(`/flueny-guidelines shows the digest on ${surface}`, async ($, on) => {
      engine(on, JSON.stringify(FILE))
      await $.prompt.context({ blocks: [] })
      const ui = await $.ui.mount({ plugin: 'flueny', surface, component: 'Pane', requestId: 'flueny-guidelines', props })
      expect(await ui.find({ type: 'Text', text: 'Small PRs' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: 'Use the session guard.' })).toBeTruthy()
    })

    test(`/flueny-guidelines says why it is empty on ${surface}`, async ($, on) => {
      engine(on, null)
      const ui = await $.ui.mount({ plugin: 'flueny', surface, component: 'Pane', requestId: 'flueny-guidelines', props })
      expect(await ui.find({ type: 'Text', text: 'No team guidelines in this session.' })).toBeTruthy()
    })
  }
})
