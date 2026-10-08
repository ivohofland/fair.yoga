# Contributing to fair.yoga

fair.yoga is a free, open-source toolkit for independent yoga teachers, built by
volunteers. You don't need to write code to help — telling us what went wrong is
a contribution too.

Everyone taking part agrees to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Teachers and students

**Something not working, or confusing?** [Open an issue](https://github.com/ivohofland/fair.yoga/issues/new/choose)
and pick *Something isn't working*. Plain words are perfect.

**An idea that would make your week easier?** Pick *I have an idea*.

**No GitHub account?** Email **hello@fair.yoga** — you'll get the same help.

**Please keep it private.** Issues on GitHub are public. Leave out names, email
addresses, phone numbers and payment details — yours, and especially your
students' or teacher's. If something can't be explained without them, email us.

## Security problems

Please don't open a public issue — see [SECURITY.md](SECURITY.md) for how to
report privately.

## Developers

**Getting set up** — [README.md](README.md) walks through installing, the
database, seed accounts and the test suite.

**How the project works** — [CLAUDE.md](CLAUDE.md) is the working guide. Read
its *Development Principles* and *Comment Discipline* before your first PR; they
are what review checks against.

**Finding something to work on** — issues labelled
[`good first issue`](https://github.com/ivohofland/fair.yoga/labels/good%20first%20issue)
are scoped for newcomers. Comment on the issue before starting so nobody
duplicates your work.

**Filing an issue as a developer** — a blank issue is fine. The most useful ones
say what was measured (file, line, command and output), what effect it has on a
teacher or student, and how it was found.

**Making a change**

1. Branch from `main`.
2. Work test-first, as CLAUDE.md's *Development Principles* describe.
3. Run `pnpm run verify` before pushing — README's *Scripts* table says what it
   needs.
4. Open a pull request that references the issue and says what you measured.
   We rebase-merge rather than squash, so keep each commit meaningful.

**Licence** — fair.yoga is licensed under the [GNU AGPL-3.0](LICENSE). By
contributing, you agree that your contribution is licensed under it too.
