import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepTranscript } from '../src/transcript.ts'
import { BUNDLE } from './helpers.ts'

// The transcript sweep is the only source of rejections in M1, and it is also the
// place a leak would be easiest: it reads a file full of prompts and code. What
// it returns is asserted here to be ids and class labels and nothing else.

const dir = mkdtempSync(join(tmpdir(), 'flueny-transcript-'))
const REPO = '/repo'

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(dir, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

function toolUse(id: string, path: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'PROMPTTEXT-let me update the tests' },
        { type: 'tool_use', id, name: 'Edit', input: { file_path: path, new_string: 'CODEBODY-secret' } },
      ],
    },
  }
}

function toolResult(id: string, content: string, isError = true): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
  }
}

test('a declined tool result becomes one rejection with a path class', () => {
  const path = writeTranscript('one.jsonl', [
    toolUse('toolu_1', `${REPO}/src/pricing.test.ts`),
    toolResult('toolu_1', "The user doesn't want to proceed with this tool use."),
  ])
  const result = sweepTranscript(path, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier })
  assert.deepEqual(result.rejections, [{ toolUseId: 'toolu_1', pathClass: 'tests' }])
  assert.ok(result.offset > 0)

  // Nothing from the transcript survives the sweep except the id and the class.
  const serialized = JSON.stringify(result.rejections)
  assert.equal(serialized.includes('PROMPTTEXT'), false)
  assert.equal(serialized.includes('CODEBODY'), false)
  assert.equal(serialized.includes('pricing.test.ts'), false)
})

test('a successful tool result is not a rejection', () => {
  const path = writeTranscript('ok.jsonl', [
    toolUse('toolu_2', `${REPO}/src/app.ts`),
    toolResult('toolu_2', 'The file has been updated.', false),
  ])
  assert.deepEqual(
    sweepTranscript(path, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier }).rejections,
    [],
  )
})

test('the offset stops a rejection being reported on every later turn', () => {
  const path = writeTranscript('offset.jsonl', [
    toolUse('toolu_3', `${REPO}/src/auth/login.ts`),
    toolResult('toolu_3', 'The user rejected this edit.'),
  ])
  const first = sweepTranscript(path, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier })
  assert.equal(first.rejections.length, 1)
  assert.equal(first.rejections[0]?.pathClass, 'auth')

  const second = sweepTranscript(path, { offset: first.offset, repoRoot: REPO, classifier: BUNDLE.pathClassifier })
  assert.deepEqual(second.rejections, [])
  assert.equal(second.offset, first.offset)
})

test('a transcript that shrank is re-read from the start rather than trusted', () => {
  const path = writeTranscript('rotated.jsonl', [
    toolUse('toolu_4', `${REPO}/README.md`),
    toolResult('toolu_4', 'The user does not want to take this action'),
  ])
  // An offset past the end of the file means the file was rotated or replaced.
  const result = sweepTranscript(path, { offset: 999_999, repoRoot: REPO, classifier: BUNDLE.pathClassifier })
  assert.equal(result.rejections.length, 1)
  assert.equal(result.rejections[0]?.pathClass, 'docs')
})

test('a missing or unparseable transcript sweeps to nothing rather than throwing', () => {
  const missing = sweepTranscript(join(dir, 'nope.jsonl'), {
    offset: 12,
    repoRoot: REPO,
    classifier: BUNDLE.pathClassifier,
  })
  assert.deepEqual(missing.rejections, [])
  assert.equal(missing.offset, 12, 'a missing file must not reset the offset')

  const broken = writeTranscript('broken.jsonl', [])
  writeFileSync(broken, 'not json at all\n{"half":\n')
  assert.deepEqual(
    sweepTranscript(broken, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier }).rejections,
    [],
  )
})

test('one rejection is reported once even if the result appears twice', () => {
  const path = writeTranscript('dupe.jsonl', [
    toolUse('toolu_5', `${REPO}/src/app.ts`),
    toolResult('toolu_5', "The user doesn't want to proceed with this tool use."),
    toolResult('toolu_5', "The user doesn't want to proceed with this tool use."),
  ])
  assert.equal(
    sweepTranscript(path, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier }).rejections.length,
    1,
  )
})

// Design decision 57's condition, expressed as a test rather than a comment.
//
// The transcript came back into scope on one term: tool-use decision records
// only, and prompt text and assistant response text are never materialised, not
// even transiently, not even locally. "Never sent" was already covered by
// redaction.test.ts. This is the stronger claim: never READ.
//
// It works by watching the only two places bytes can become a value, a Buffer
// decode and a JSON parse, for the duration of one sweep, and failing if a
// sentinel planted in the message bodies ever appears in one. An implementation
// that decodes a line or parses a record fails this even though its return value
// would look perfectly clean.
test('the sweep never materialises prompt or response text, only ids and paths', () => {
  const secret = 'SENTINEL-e7b41f-NEVER-READ'
  const path = writeTranscript('never-read.jsonl', [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `${secret} let me refactor the pricing module` },
          {
            type: 'tool_use',
            id: 'toolu_57',
            name: 'Edit',
            input: { file_path: `${REPO}/src/auth/session.ts`, new_string: `${secret} in a diff` },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `${secret} in a follow up prompt` },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_57',
            is_error: true,
            content: `The user doesn't want to proceed with this tool use. ${secret}`,
          },
        ],
      },
    },
  ])

  const decoded: string[] = []
  const realToString = Buffer.prototype.toString
  const realParse = JSON.parse
  Buffer.prototype.toString = function (this: Buffer, ...args: unknown[]) {
    const out = (realToString as (...a: unknown[]) => string).apply(this, args)
    decoded.push(out)
    return out
  } as typeof Buffer.prototype.toString
  JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) => {
    decoded.push(String(text))
    return realParse(text, reviver)
  }) as typeof JSON.parse

  let result
  try {
    result = sweepTranscript(path, { offset: 0, repoRoot: REPO, classifier: BUNDLE.pathClassifier })
  } finally {
    Buffer.prototype.toString = realToString
    JSON.parse = realParse
  }

  // The sweep still has to work. A version that reads nothing would pass the
  // leak assertion below and be useless.
  assert.deepEqual(result.rejections, [{ toolUseId: 'toolu_57', pathClass: 'auth' }])

  const leaked = decoded.filter((value) => value.includes(secret))
  assert.deepEqual(
    leaked,
    [],
    `prompt or response text was materialised ${leaked.length} time(s): ${JSON.stringify(leaked.slice(0, 2))}`,
  )
})
