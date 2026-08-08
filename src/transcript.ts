import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { classifyPath } from './classify.ts'
import { looksDeclined, toRepoRelative } from './extract.ts'

// Where rejections come from.
//
// `PostToolUse` fires after a tool has run, so a tool the developer declined
// never reaches it. Discernment is the competency built on exactly that fact
// ("You rejected 3 of 11 agent edits this week"), so without another source this
// milestone can only ever report a 0% rejection rate, which is not a low number,
// it is a wrong one. The other source that does not require a `PreToolUse` gate,
// which is M3 and explicitly out of scope, is the session transcript.
//
// It is read here, on this machine, at `Stop`. What comes out is a list of ids
// and one class label each. No message, no tool argument and no result body
// leaves this function, and the transcript path itself is never transmitted.

const MAX_TAIL_BYTES = 8 * 1024 * 1024

export interface Rejection {
  toolUseId: string
  pathClass: string | null
}

export interface SweepResult {
  rejections: Rejection[]
  offset: number
}

export function sweepTranscript(
  transcriptPath: string,
  opts: { offset: number; repoRoot: string | null; classifier: Record<string, string[]> },
): SweepResult {
  let size: number
  try {
    size = statSync(transcriptPath).size
  } catch {
    return { rejections: [], offset: opts.offset }
  }
  // A transcript that shrank was rotated or replaced, so the stored offset points
  // at nothing meaningful and starting over is the only honest reading.
  const offset = opts.offset > size ? 0 : opts.offset
  if (size === 0) return { rejections: [], offset: 0 }

  const start = Math.max(0, size - MAX_TAIL_BYTES)
  const buffer = readRange(transcriptPath, start, size - start)
  if (!buffer) return { rejections: [], offset: size }

  // Tool calls are indexed from the whole tail, not only from new bytes: the
  // call that got declined is usually a line or two before the result, but on a
  // long turn it can be on the far side of the offset.
  const paths = new Map<string, string | null>()
  const rejections: Rejection[] = []
  const seen = new Set<string>()

  let cursor = start
  for (const line of buffer.toString('utf8').split('\n')) {
    const lineStart = cursor
    cursor += Buffer.byteLength(line, 'utf8') + 1
    if (!line.trim()) continue
    // The first line of a truncated tail is usually half a record.
    if (lineStart < start + 1 && start > 0) continue

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    for (const block of contentBlocks(record)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const raw = firstString(block.input, ['file_path', 'notebook_path', 'path', 'filePath'])
        paths.set(block.id, raw ? classifyPath(opts.classifier, toRepoRelative(raw, opts.repoRoot)) : null)
        continue
      }
      if (block.type !== 'tool_result' || lineStart < offset) continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
      if (!id || seen.has(id)) continue
      if (!looksDeclined(block.content)) continue
      seen.add(id)
      rejections.push({ toolUseId: id, pathClass: paths.get(id) ?? null })
    }
  }

  return { rejections, offset: size }
}

interface Block {
  type?: string
  id?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
}

function contentBlocks(record: unknown): Block[] {
  if (!isRecord(record)) return []
  const message = isRecord(record.message) ? record.message : record
  const content = message.content
  if (!Array.isArray(content)) return []
  return content.filter(isRecord) as Block[]
}

function readRange(path: string, start: number, length: number): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function firstString(source: unknown, keys: string[]): string | null {
  if (!isRecord(source)) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
