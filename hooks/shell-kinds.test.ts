import { describe, expect, test } from 'claude-code/testing'

import { SHELL_KINDS_FIXTURE } from './shell-kinds.fixture'
import { commandKind, secretsActionOf, secretsFileOf, topShellKinds } from './shell-kinds'

// The same examples src/extract.rs runs (feature 0154): the binary and the
// coach name a command and a secrets file the same way, or both suites fail.
describe('shell kinds and secrets files, as the binary decides them', () => {
  test('every command in the shared fixture gets the binary kind', () => {
    expect(SHELL_KINDS_FIXTURE.commandKinds.length).toBeGreaterThan(50)
    for (const [command, kind] of SHELL_KINDS_FIXTURE.commandKinds) {
      expect([command, commandKind(command)]).toEqual([command, kind])
    }
  })

  test('every tool use in the shared fixture gets the binary secrets kind', () => {
    expect(SHELL_KINDS_FIXTURE.secretsFiles.length).toBeGreaterThan(20)
    for (const { tool, input, kind } of SHELL_KINDS_FIXTURE.secretsFiles) {
      expect([tool, input, secretsFileOf(tool, input)?.kind ?? null]).toEqual([tool, input, kind])
    }
  })

  test('the coach keeps the basename, env first', () => {
    expect(secretsFileOf('Bash', { command: 'cp ../../app-backend/.env .env' })?.name).toBe('.env')
    expect(secretsFileOf('Bash', { command: 'cat server.pem "web/.env.local"' })?.name).toBe('.env.local')
    expect(secretsFileOf('Read', { file_path: '/repo/certs/server.key' })?.name).toBe('server.key')
  })

  test('the action is worded by what was done', () => {
    expect(secretsActionOf('Read', undefined)).toBe('read')
    expect(secretsActionOf('Edit', undefined)).toBe('edited')
    expect(secretsActionOf('Write', undefined)).toBe('edited')
    expect(secretsActionOf('Bash', 'cat .env.local')).toBe('read')
    expect(secretsActionOf('Bash', 'source .env')).toBe('read')
    expect(secretsActionOf('Bash', 'cp ../../app-backend/.env .env')).toBe('copied or moved')
    expect(secretsActionOf('Bash', 'mv .env .env.bak')).toBe('copied or moved')
    expect(secretsActionOf('Bash', 'docker run --env-file=.env app')).toBe('touched')
  })

  test('the top three kinds, most first, ties in precedence order', () => {
    expect(topShellKinds({})).toBe('')
    expect(topShellKinds({ other: 1, inspect: 6, network: 2, search: 3 })).toBe(
      'Looking at files 6 · Searching files 3 · Network request 2',
    )
    expect(topShellKinds({ files: 2, git: 2 })).toBe('Git 2 · Moving or deleting files 2')
  })
})
