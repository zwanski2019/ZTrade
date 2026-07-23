## What this changes

<!-- One or two sentences. The diff shows what; explain why. -->

## How this fails and how it recovers

<!--
REQUIRED for any subsystem change. Not a formality — if you cannot describe
the failure mode, the subsystem is not finished.

- What breaks it?
- How does an operator find out?
- What happens next: does it degrade, retry, halt, or need a human?
-->

## Checklist

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` passing
- [ ] `pnpm gate:parity` green
- [ ] `pnpm gate:secrets` green
- [ ] No `Date.now()` / I/O / exchange access added to strategy code
- [ ] No secrets, real keys, or live account identifiers in the diff
- [ ] Tests added for the behaviour changed (property tests preferred on money paths)

## Risk

<!-- Does this touch order placement, sizing, or risk checks? Say so plainly. -->
