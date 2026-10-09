// Feature 0154. The binary's shell command kinds and secrets file rules, in
// TypeScript, so the coach pane can show them without asking the binary.
//
// Mirrors `command_category` and `secrets_file` in src/extract.rs: the same
// patterns, the same precedence, the same segment-start matching. Change both
// together. hooks/shell-kinds.fixture.ts holds the examples both test suites
// run, so the two cannot drift apart unnoticed.
//
// Everything here runs on the machine. A command or path goes in, a kind (and,
// for the coach's own line, a basename) comes out, and nothing is sent.

import type { CommandKind, SecretsAction, SecretsKind } from '../types'
import { isTestCommand } from './coach-rules'


// Precedence order, which is also the tie-break order on the pane.
export const COMMAND_KINDS: readonly CommandKind[] = [
  'test',
  'git',
  'build',
  'install',
  'run',
  'network',
  'search',
  'inspect',
  'files',
  'other',
]

// The live feed's row labels (0154 API contract), so the pane and the feed
// name a command the same way.
export const COMMAND_KIND_LABELS: Record<CommandKind, string> = {
  test: 'Running tests',
  git: 'Git',
  build: 'Build or lint',
  install: 'Installing packages',
  run: 'Running a script or app',
  network: 'Network request',
  search: 'Searching files',
  inspect: 'Looking at files',
  files: 'Moving or deleting files',
  other: 'Shell command',
}

const anyOf = (patterns: readonly string[]): RegExp => new RegExp(patterns.join('|'), 'i')

// Feature 0149 kinds.
const GIT_COMMAND = /(^|[\s;&|(])(git|gh)\s+\S/i

const BUILD_COMMAND = anyOf([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck|type-check|tsc|format|fmt|check)\b`,
  String.raw`\bnpx?\s+(tsc|eslint|prettier|biome|next\s+(build|lint)|vite\s+build)\b`,
  String.raw`(^|[\s;&|(])(tsc|eslint|prettier|biome|ruff|black|flake8|mypy|pylint|rubocop|golangci-lint)\b`,
  String.raw`\bcargo\s+(build|check|clippy|fmt)\b`,
  String.raw`\bgo\s+(build|vet)\b`,
  String.raw`\b(mvn|mvnw|gradle|gradlew)\s+(\S+\s+)*(compile|package|build|assemble)\b`,
  String.raw`\bdotnet\s+build\b`,
  String.raw`\bdocker(\s+compose|-compose)?\s+build\b`,
  String.raw`(^|[\s;&|(])make(\s|$)`,
  String.raw`\bswift\s+build\b`,
])

const INSTALL_COMMAND = anyOf([
  String.raw`\b(npm|pnpm|bun)\s+(i|install|ci|add)\b`,
  String.raw`\byarn(\s+(install|add)\b|\s*$)`,
  String.raw`\b(pip|pip3|uv\s+pip)\s+install\b`,
  String.raw`\b(uv|poetry|cargo)\s+add\b`,
  String.raw`\b(poetry|bundle|cargo|gem|brew|composer)\s+install\b`,
  String.raw`\bgo\s+(get|mod\s+(download|tidy))\b`,
  String.raw`\bapt(-get)?\s+install\b`,
  String.raw`\bdotnet\s+(add|restore)\b`,
])

// Feature 0154 kinds: a command word only at a real segment start, optionally
// behind sudo, env, time, nohup or VAR=value.
const SEGMENT_START = String.raw`(?:^|[;&|(\x60\n])\s*(?:(?:sudo|env|time|nohup)\s+|\w+=\S*\s+)*`
const WORD_END = String.raw`(?:\s|$|[;&|)\x60])`

const segment = (patterns: readonly string[]): RegExp => anyOf(patterns.map(p => `${SEGMENT_START}(?:${p})`))

const RUN_COMMAND = segment([
  String.raw`node\s+[^\s-]`,
  String.raw`python[23]?(?:\.\d+)?\s+\S`,
  String.raw`ruby\s+\S`,
  String.raw`deno\s+(?:run|task)\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+run\s+\S`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:dev|start|serve|preview)\b`,
  String.raw`(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+\S`,
  String.raw`\./[\w.-]`,
  String.raw`(?:bash|sh|zsh)\s+[^\s-]`,
  String.raw`cargo\s+run\b`,
  String.raw`go\s+run\b`,
  String.raw`docker\s+run\b`,
  String.raw`(?:docker\s+compose|docker-compose)\s+(?:\S+\s+)*?(?:up|run)\b`,
  String.raw`(?:uv|poetry)\s+run\s+\S`,
  String.raw`(?:bundle\s+exec\s+)?rails\s+(?:s|server)\b`,
  String.raw`uvicorn\s`,
  String.raw`flask\s+run\b`,
])

const NETWORK_COMMAND = segment([`(?:curl|wget|https?|ssh|scp|rsync|ping|dig|nslookup|nc)${WORD_END}`])

const SEARCH_COMMAND = segment([`(?:grep|egrep|fgrep|rg|find|fd|ag|ack)${WORD_END}`])

const INSPECT_COMMAND = segment([
  `(?:ls|cat|head|tail|less|more|wc|tree|stat|file|pwd|du|jq)${WORD_END}`,
  String.raw`sed\s+(?:-\S+\s+)*-n\b`,
])

const FILES_COMMAND = segment([`(?:mkdir|rm|rmdir|mv|cp|touch|chmod|chown|ln)${WORD_END}`])

const KINDS_IN_ORDER: readonly [CommandKind, RegExp][] = [
  ['git', GIT_COMMAND],
  ['build', BUILD_COMMAND],
  ['install', INSTALL_COMMAND],
  ['run', RUN_COMMAND],
  ['network', NETWORK_COMMAND],
  ['search', SEARCH_COMMAND],
  ['inspect', INSPECT_COMMAND],
  ['files', FILES_COMMAND],
]

export const commandKind = (command: string): CommandKind => {
  if (isTestCommand(command)) {
    return 'test'
  }

  return KINDS_IN_ORDER.find(([, pattern]) => pattern.test(command))?.[0] ?? 'other'
}

// Secrets files, as `secrets_file` decides them.
const ENV_TEMPLATES = ['example', 'sample', 'template', 'dist', 'defaults']
const KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ed25519', '.netrc']

const basename = (word: string): string => {
  const unquoted = word.replace(/^['"]+|['"]+$/g, '')

  return unquoted.split(/[/\\]/).pop() ?? unquoted
}

export const secretsKindOf = (word: string): SecretsKind | null => {
  const name = basename(word).toLowerCase()
  if (name === '.env') {
    return 'env'
  }
  if (name.startsWith('.env.')) {
    const suffix = name.slice('.env.'.length)

    return suffix !== '' && !ENV_TEMPLATES.includes(suffix) ? 'env' : null
  }
  const isKey = KEY_NAMES.includes(name) || (name.length > 4 && (name.endsWith('.pem') || name.endsWith('.key')))

  return isKey ? 'key' : null
}

export type SecretsHit = { kind: SecretsKind; name: string }

// The first env file named, else the first key, with its basename for the
// coach's own line. Words are split as the binary splits them.
export const secretsIn = (words: readonly string[]): SecretsHit | null => {
  let key: SecretsHit | null = null
  for (const word of words) {
    const kind = secretsKindOf(word)
    if (kind === 'env') {
      return { kind, name: basename(word) }
    }
    if (kind === 'key' && key === null) {
      key = { kind, name: basename(word) }
    }
  }

  return key
}

export const commandWords = (command: string): string[] => command.split(/[\s;&|()<>`=:]/)

// Tool names as the binary groups them (src/extract.rs), lowercased.
const SUBAGENT_TOOLS = ['task', 'agent', 'spawn_subagent']
const BASH_TOOLS = [
  'bash',
  'shell',
  'terminal',
  'run_terminal_cmd',
  'run_terminal_command',
  'bashoutput',
  'killshell',
  'killbash',
]
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'target_file']
const COMMAND_KEYS = ['command', 'cmd']

const firstString = (input: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') {
      return value
    }
  }

  return undefined
}

// What a tool use's input says about secrets files: its file path for any
// tool, and every word of its command for a shell tool. A subagent is never
// flagged, as the binary never flags one.
export const secretsFileOf = (tool: string, input: Record<string, unknown>): SecretsHit | null => {
  const lower = tool.toLowerCase()
  if (SUBAGENT_TOOLS.includes(lower)) {
    return null
  }
  const words: string[] = []
  const path = firstString(input, PATH_KEYS)
  if (path !== undefined) {
    words.push(path)
  }
  const command = firstString(input, COMMAND_KEYS)
  if (command !== undefined && BASH_TOOLS.includes(lower)) {
    words.push(...commandWords(command))
  }

  return secretsIn(words)
}

const READ_TOOLS = ['read', 'read_file', 'cat', 'view', 'notebookread', 'read_many_files', 'grep']
const EDIT_TOOLS = ['edit', 'write', 'multiedit', 'notebookedit', 'applypatch', 'apply_patch', 'update', 'search_replace']
const COPY_OR_MOVE = new RegExp(`${SEGMENT_START}(?:cp|mv)${WORD_END}`, 'i')
const SOURCE = new RegExp(`${SEGMENT_START}(?:source|\\.)\\s`, 'i')

// How the coach words what was done to the file. Only for its own line.
export const secretsActionOf = (tool: string, command: string | undefined): SecretsAction => {
  const lower = tool.toLowerCase()
  if (EDIT_TOOLS.includes(lower)) {
    return 'edited'
  }
  if (READ_TOOLS.includes(lower)) {
    return 'read'
  }
  if (command !== undefined && BASH_TOOLS.includes(lower)) {
    if (COPY_OR_MOVE.test(command)) {
      return 'copied or moved'
    }
    const kind = commandKind(command)
    if (kind === 'inspect' || kind === 'search' || SOURCE.test(command)) {
      return 'read'
    }
  }

  return 'touched'
}

// The pane's "What Claude ran" value: the most used kinds, most first, ties in
// precedence order, each with its live feed label and count.
export const topShellKinds = (counts: Partial<Record<CommandKind, number>>, limit = 3): string =>
  COMMAND_KINDS.map(kind => [kind, counts[kind] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([kind, count]) => `${COMMAND_KIND_LABELS[kind]} ${count}`)
    .join(' · ')
