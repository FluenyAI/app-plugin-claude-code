import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { classifyPath } from './classify.ts'
import { toRepoRelative } from './extract.ts'
import { bytesLookDeclined } from './decline.ts'

// Where rejections come from.
//
// `PostToolUse` fires after a tool has run, so a tool the developer declined
// never reaches it. Discernment is the competency built on exactly that fact
// ("You rejected 3 of 11 agent edits this week"), so without another source this
// milestone can only ever report a 0% rejection rate, which is not a low number,
// it is a wrong one. The other source that does not require a `PreToolUse` gate,
// which is M3 and explicitly out of scope, is the session transcript.
//
// DESIGN DECISION 57 GOVERNS THIS FILE. The transcript was out of scope until
// the hook contract was driven rather than read, and it came back in on one
// condition: tool-use decision records only, and prompt text and assistant
// response text are never materialised, not even transiently, not even locally.
//
// So this is a byte scanner. No line is ever decoded. No record is ever parsed.
// The only strings that come into existence are the short scalars pulled out by
// name, bounded: tool use ids, and the file path a tool was pointed at. A
// message body has no name to be pulled out by and is never touched, which is
// the difference between a promise and a comment claiming one.
//
// `test/redaction.test.ts` enforces this by spying on every Buffer decode and
// every JSON parse for the duration of a sweep and failing if a sentinel
// planted in the prompt text ever appears in one. If you make this file decode
// a line, that test goes red, which is the point of it.

const MAX_TAIL_BYTES = 8 * 1024 * 1024

// Bounds on the only two values this file is allowed to read.
const MAX_ID_BYTES = 256
const MAX_PATH_BYTES = 4096

const NL = 0x0a

const TOOL_USE = Buffer.from('"type":"tool_use"', 'ascii')
const TOOL_RESULT = Buffer.from('"type":"tool_result"', 'ascii')
const ID_KEY = Buffer.from('"id":"', 'ascii')
const TOOL_USE_ID_KEY = Buffer.from('"tool_use_id":"', 'ascii')
// `"path":"` cannot match inside `"file_path":"`, because the byte before `path`
// there is an underscore, not a quote. Same for `"id":"` against
// `"tool_use_id":"`. The needles carry their own opening quote for that reason.
const PATH_KEYS = ['"file_path":"', '"notebook_path":"', '"filePath":"', '"path":"'].map((k) =>
  Buffer.from(k, 'ascii'),
)

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

  let lineStart = 0
  while (lineStart < buffer.length) {
    let lineEnd = buffer.indexOf(NL, lineStart)
    if (lineEnd < 0) lineEnd = buffer.length
    const absolute = start + lineStart

    // The first line of a truncated tail is usually half a record. A partial
    // line is not a parse failure here, nothing parses it, but half a record
    // can still carry a whole marker and would be counted twice on the next
    // sweep from a clean offset.
    if (!(start > 0 && lineStart === 0)) {
      scanLine(buffer, lineStart, lineEnd, absolute >= offset, opts, paths, rejections, seen)
    }
    lineStart = lineEnd + 1
  }

  return { rejections, offset: size }
}

// One line, as bytes. Blocks are found by their structural markers and each one
// owns the span up to the next marker, so a forward search for a key cannot
// bleed out of the block that started it.
function scanLine(
  buf: Buffer,
  lineStart: number,
  lineEnd: number,
  isNew: boolean,
  opts: { repoRoot: string | null; classifier: Record<string, string[]> },
  paths: Map<string, string | null>,
  rejections: Rejection[],
  seen: Set<string>,
): void {
  const blocks = blockStarts(buf, lineStart, lineEnd)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const blockEnd = i + 1 < blocks.length ? blocks[i + 1]!.at : lineEnd

    if (block.kind === 'use') {
      const id = readStringField(buf, block.at, blockEnd, ID_KEY, MAX_ID_BYTES)
      if (!id) continue
      let raw: string | null = null
      for (const key of PATH_KEYS) {
        raw = readStringField(buf, block.at, blockEnd, key, MAX_PATH_BYTES)
        if (raw) break
      }
      paths.set(id, raw ? classifyPath(opts.classifier, toRepoRelative(raw, opts.repoRoot)) : null)
      continue
    }

    // A result older than the offset was already reported on an earlier sweep.
    if (!isNew) continue
    const id = readStringField(buf, block.at, blockEnd, TOOL_USE_ID_KEY, MAX_ID_BYTES)
    if (!id || seen.has(id)) continue
    // The decline test never leaves the buffer. This is the whole reason the
    // byte path in decline.ts exists: answering "was this declined" without
    // reading the tool result it is asking about.
    if (!bytesLookDeclined(buf, block.at, blockEnd)) continue
    seen.add(id)
    rejections.push({ toolUseId: id, pathClass: paths.get(id) ?? null })
  }
}

function blockStarts(buf: Buffer, from: number, to: number): { at: number; kind: 'use' | 'result' }[] {
  const found: { at: number; kind: 'use' | 'result' }[] = []
  for (const [needle, kind] of [
    [TOOL_USE, 'use'],
    [TOOL_RESULT, 'result'],
  ] as const) {
    let at = from
    for (;;) {
      const hit = indexOf(buf, at, to, needle)
      if (hit < 0) break
      found.push({ at: hit, kind })
      at = hit + needle.length
    }
  }
  return found.sort((a, b) => a.at - b.at)
}

// Reads one short JSON string value by key. This is the only place in the sweep
// where bytes become a string, and it is bounded by `max` so that a key whose
// value is unexpectedly enormous is abandoned rather than read.
function readStringField(
  buf: Buffer,
  from: number,
  to: number,
  key: Buffer,
  max: number,
): string | null {
  const at = indexOf(buf, from, to, key)
  if (at < 0) return null
  const valueStart = at + key.length
  const limit = Math.min(to, valueStart + max)
  let i = valueStart
  while (i < limit) {
    const byte = buf[i]!
    if (byte === 0x5c) {
      i += 2
      continue
    }
    if (byte === 0x22) {
      const raw = buf.toString('utf8', valueStart, i)
      try {
        return JSON.parse(`"${raw}"`) as string
      } catch {
        return null
      }
    }
    i++
  }
  return null
}

function indexOf(buf: Buffer, from: number, to: number, needle: Buffer): number {
  const limit = to - needle.length
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
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
