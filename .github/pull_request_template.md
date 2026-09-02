<!--
Required PR format for this repository.
All human- and AI-authored PRs should follow this structure exactly.
Do not replace these sections with custom headings.
If a checklist item does not apply, keep it and add a brief note instead of deleting it.

Before opening: set a milestone, at least one `type:`/`area:`/`prio:` label,
and an assignee on the PR itself (not just this description) - these are
metadata on the PR object, not something this template can fill in for you.
-->

## Description

<!--
What does this PR do? What problem does it solve?
Be explicit about scope. If this is docs-only or infra-only, say so clearly.
-->

## How to test

<!--
List concrete verification steps.
If tests were not run, state that plainly and explain why.
-->

## What stays / known limitations

<!--
Anything intentionally left out, deferred, or still transitional.
Mention follow-up milestones/issues when relevant.
-->

---

## Checklist

- [ ] Milestone, label(s) (`type:`/`area:`/`prio:`), and assignee are set on this PR
- [ ] No secrets / keys / passwords in the diff
- [ ] `SHARED_SECRET`/`WPCC_SHARED_SECRET` values are placeholders, not real ones
- [ ] Tests pass locally (`npm test` in `service/`)
- [ ] Every `uses:` in touched workflow files is pinned to a full commit SHA, not a mutable tag
- [ ] Dockerfile changes: re-verified against a real Puppeteer render, not just a successful build
- [ ] Documentation updated if behavior, setup, or security controls changed
