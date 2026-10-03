// Feature 0137. The team guidelines the binary writes to guidelines.json after
// each handshake: where the file is, what a valid one looks like, which path
// class an edited file belongs to, and the context block Claude reads.
//
// The file is org-authored text that came from the server. The paths matched
// here are the agent's edits, classified in memory and dropped, the same way
// src/classify.rs does it.

import type { GuidelineSection, TeamGuidelines } from '../types'

export const GUIDELINES_FILE = 'guidelines.json'

// Mirrors Store::from_env and home_dir in src/store.rs: FLUENY_CONFIG_DIR,
// else $XDG_CONFIG_HOME/flueny, else ~/.config/flueny.
export const configDir = (env: (name: string) => string | undefined): string | null => {
  const set = (name: string) => {
    const value = env(name)

    return value !== undefined && value !== '' ? value : undefined
  }
  const explicit = set('FLUENY_CONFIG_DIR')
  if (explicit) {
    return explicit
  }
  const xdg = set('XDG_CONFIG_HOME')
  if (xdg) {
    return `${xdg}/flueny`
  }
  const home = set('HOME') ?? set('USERPROFILE')

  return home ? `${home}/.config/flueny` : null
}

const isString = (v: unknown): v is string => typeof v === 'string'

const parseSection = (v: unknown): GuidelineSection | null => {
  if (typeof v !== 'object' || v === null) {
    return null
  }
  const { pathClass, title, points } = v as Record<string, unknown>
  if (!isString(pathClass) || !isString(title) || !Array.isArray(points) || !points.every(isString)) {
    return null
  }

  return { pathClass, title, points }
}

// Anything that is not the shape the binary writes reads as no guidelines, so a
// half-written or hand-edited file never reaches Claude's context.
export const parseGuidelines = (text: string): TeamGuidelines | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const { etag, publishedAt, summary, sections, pathClassifier } = raw as Record<string, unknown>
  if (!isString(etag) || !isString(publishedAt) || !isString(summary) || !Array.isArray(sections)) {
    return null
  }
  const parsed = sections.map(parseSection)
  if (parsed.some(s => s === null)) {
    return null
  }
  const classifier: [string, string[]][] = []
  if (typeof pathClassifier === 'object' && pathClassifier !== null) {
    // Object key order is the bundle's order, which is the contract.
    for (const [pathClass, patterns] of Object.entries(pathClassifier)) {
      if (Array.isArray(patterns)) {
        classifier.push([pathClass, patterns.filter(isString)])
      }
    }
  }

  return { etag, publishedAt, summary, sections: parsed as GuidelineSection[], pathClassifier: classifier }
}

// ---- the glob subset of src/classify.rs: `**/`, `**`, `*` and `?` ----

type Token = { kind: 'literal'; char: string } | { kind: 'star' | 'anyDeep' | 'anyDirs' | 'one' }

const tokenize = (pattern: string): Token[] => {
  const out: Token[] = []
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out.push({ kind: 'anyDirs' })
        i += 3
      } else {
        out.push({ kind: 'anyDeep' })
        i += 2
      }
    } else if (c === '*') {
      out.push({ kind: 'star' })
      i += 1
    } else if (c === '?') {
      out.push({ kind: 'one' })
      i += 1
    } else {
      out.push({ kind: 'literal', char: c ?? '' })
      i += 1
    }
  }

  return out
}

export const globMatch = (pattern: string, path: string): boolean => {
  const tokens = tokenize(pattern)
  const memo = new Map<number, boolean>()
  const go = (t: number, s: number): boolean => {
    const key = t * (path.length + 1) + s
    const known = memo.get(key)
    if (known !== undefined) {
      return known
    }
    const token = tokens[t]
    let result: boolean
    if (token === undefined) {
      result = s === path.length
    } else if (token.kind === 'literal') {
      result = path[s] === token.char && go(t + 1, s + 1)
    } else if (token.kind === 'one') {
      result = s < path.length && path[s] !== '/' && go(t + 1, s + 1)
    } else if (token.kind === 'star') {
      result = false
      for (let end = s; ; end += 1) {
        if (go(t + 1, end)) {
          result = true
          break
        }
        if (end >= path.length || path[end] === '/') {
          break
        }
      }
    } else if (token.kind === 'anyDeep') {
      result = false
      for (let end = s; end <= path.length && !result; end += 1) {
        result = go(t + 1, end)
      }
    } else {
      // Zero directories, or any prefix that ends just after a slash.
      result = go(t + 1, s)
      for (let i = s; i < path.length && !result; i += 1) {
        result = path[i] === '/' && go(t + 1, i + 1)
      }
    }
    memo.set(key, result)

    return result
  }

  return go(0, 0)
}

// Repo relative, forward slashes, as to_repo_relative in src/extract.rs gives
// the classifier. A path outside the root is matched as given.
export const relativeTo = (root: string, path: string): string => {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const base = norm(root).replace(/\/+$/, '')
  const full = norm(path)
  const rel = full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full

  return rel.replace(/^\.\//, '').replace(/^\/+/, '')
}

export const classifyPath = (classifier: readonly [string, string[]][], relPath: string): string | null => {
  if (relPath === '') {
    return null
  }
  for (const [pathClass, patterns] of classifier) {
    if (patterns.some(pattern => globMatch(pattern, relPath))) {
      return pathClass
    }
  }

  return null
}

export const CONTEXT_BLOCK = 'teamGuidelines'

// What Claude reads at the start of each conversation.
export const contextText = (g: TeamGuidelines): string => {
  const lines = [
    "These are this team's engineering guidelines, published by the organisation's admins through " +
      'Flueny. Follow them when you write, change or review code in this session. When a request ' +
      'conflicts with one, say so and ask before going against it.',
    '',
    g.summary,
  ]
  for (const section of g.sections) {
    lines.push('', `## ${section.title} (${section.pathClass === 'general' ? 'all code' : `${section.pathClass} code`})`)
    for (const point of section.points) {
      lines.push(`- ${point}`)
    }
  }

  return lines.join('\n')
}
