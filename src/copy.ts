// The terminal copy, from the `### Terminal copy` section of
// app-docs/designs/coding-agent-surface.md.
//
// Voice: instrument, not coach. Second person for the developer, "Flueny" for the
// product, never "we". No praise and no adjectives of judgement. ASCII only, no
// emoji and no box drawing, because terminals and CI logs vary. Colour is never
// the sole carrier of meaning, which here is simply that nothing emits colour.
//
// Two rules in that section contradict each other on two of the six strings: the
// exemplars for "Setup" and "Dry-run daily receipt" are 85 and 87 columns wide
// against a stated 80 column hard cap. The words are the contract, so they are
// kept verbatim and reflowed to 80 by `wrap`; test/copy.test.ts asserts both
// halves, that no rendered line exceeds 80 and that the reflowed text still reads
// back word for word. Flagged in the feature file rather than silently rewritten.

export const COLUMNS = 80

export function wrap(text: string, width = COLUMNS): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

// 1. Setup, after SSO completes.
export function setupConnected(opts: { dryRun: boolean; dryRunDays: number; appUrl: string }): string {
  // The exemplar says "7 days" because seven is the default window. Printing 7
  // when the server said 3 would be a number the product cannot substantiate,
  // which is the same section's last rule, so the count comes from the handshake.
  const first = opts.dryRun
    ? `Flueny is connected. Dry run is on for ${opts.dryRunDays} ${plural(opts.dryRunDays, 'day')}: ` +
      'nothing is scored, nothing is blocked.'
    : 'Flueny is connected. Dry run is over: signal is scored, nothing is blocked.'
  const second =
    'Your prompts and your code never leave this machine. ' +
    `See what is sent: ${opts.appUrl}/coding/privacy`
  return render([first, second])
}

// 2. Dry-run daily receipt (design decision 44).
export function dailyReceipt(opts: { toolCalls: number; signals: number; blocked: number }): string {
  return render([
    `Flueny observed ${opts.toolCalls} ${plural(opts.toolCalls, 'tool call')} today. ` +
      `It would have sent ${opts.signals} ${plural(opts.signals, 'signal')} and blocked ` +
      `${opts.blocked} ${plural(opts.blocked, 'action')}.`,
    'See exactly what: flueny dry-run --today',
  ])
}

// 3. PostToolUse nudge. M2, delivered as `additionalContext`. Nothing in M1 calls
// this: `SessionStartResponse.intervention` is always null and the client must
// not treat a string there as something it can render yet.
export function nudge(opts: { finding: string; standard: string; url: string }): string {
  return render([
    `Flueny: ${opts.finding} Your org's standard ${opts.standard} requires ` +
      'parameterized queries.',
    `Why: ${opts.url}`,
  ])
}

// 4. PreToolUse denial. M3, four parts in this order. Unused in M1 by design:
// `capabilities.canEnforce` is false for every agent and there is no gate.
export function denial(opts: { reason: string; rule: string; url: string; token: string }): string {
  return render([
    `Flueny blocked this command because ${opts.reason}`,
    `Rule: ${opts.rule}`,
    `Why: ${opts.url}`,
    `Proceed anyway: flueny allow --once ${opts.token}   (recorded)`,
  ])
}

// 5. Weekly summary. `/coding/signal` is authoritative and this is additive
// (design decision 46).
export function weeklySummary(opts: {
  rejected: number
  decisions: number
  touchedTests: number
  appUrl: string
}): string {
  const first =
    `You rejected ${opts.rejected} of ${opts.decisions} agent ` +
    `${plural(opts.decisions, 'edit')} this week.`
  // The exemplar's second sentence only exists when the number is not zero.
  // "None of them touched tests" is a sentence about nothing happening, and the
  // rule against unsubstantiated numbers cuts both ways.
  const tests =
    opts.touchedTests > 0
      ? ` ${capitalize(numberWord(opts.touchedTests))} of them touched tests.`
      : ''
  return render([first + tests, `Full breakdown: ${opts.appUrl}/coding/signal`])
}

// 6. Capability unlock at SessionStart. M4 (design decision 47).
export function capabilityUnlock(opts: { pathClass: string }): string {
  return render([`Flueny: agent writes to ${opts.pathClass}/ are now available on this account.`])
}

// The one place a rendered string becomes terminal output. ASCII is enforced here
// rather than trusted, because the strings interpolate a URL and a path class
// that come from a server.
function render(parts: string[]): string {
  return parts
    .flatMap((part) => wrap(toAscii(part)))
    .join('\n')
}

export function toAscii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '')
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

export function numberWord(value: number): string {
  return WORDS[value] ?? String(value)
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
