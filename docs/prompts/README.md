# Phase prompts

The prompts deployhealth's phases were built from, exactly as they were given to Claude Code.

- [Phase 4.5 — Launch polish](phase-4-5-launch-polish.md)
- [Phase 4.6 — Scanner accuracy on real repos](phase-4-6-scanner-accuracy.md)

Earlier phases followed the same structure, but their prompts weren't kept.

## The review loop

Every phase runs the same way:

1. **Plan.** The prompt states the goal, the scope and the tests. Claude Code reads
   [CLAUDE.md](../../CLAUDE.md) and replies with the file structure, any schema change and a list
   of numbered decisions, then stops.
2. **Decisions.** The maintainer approves each decision or amends it ("7: list every name up to
   six"). Nothing is built before that.
3. **Build.** Small conventional commits, the relevant tests after each change.
4. **Full suite** on the tip: typecheck, lint, unit tests, build and the Playwright e2e run.
5. **Summary.** What's done, what's stubbed, which decisions need review, and the human steps
   still owed (publishing, dashboard settings, redeploys).
6. **Review before merge.** The maintainer reads the diff and the summary, then pushes and merges.

The working and code conventions every phase follows live in [CLAUDE.md](../../CLAUDE.md).
