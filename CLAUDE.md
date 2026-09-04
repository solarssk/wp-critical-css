# Claude Code — wp-critical-css

@AGENTS.md

## 1. Verify, don't assume

**A green checkmark or a plausible theory is not proof — go look at the actual artifact.**

This repo has already shipped bugs that a dashboard or a status check made look fine: a NOSONAR comment that silently suppressed nothing (the rule reports with no anchor line — only caught by querying SonarCloud's own issues-search API directly), a coverage report showing 0% on real, tested code (only caught by downloading the raw Clover XML and grepping it), a Dependabot Puppeteer bump that broke the real render path (only caught by actually building the Docker image and running the smoke test locally, not by reading the diff). Before telling the user something is fixed: reproduce it, re-run it, or pull the raw data — don't infer success from "the PR is green" or "this is how it usually works."

**The test:** if the user asked "how do you know," would the answer be "I checked the raw output," or "it looked right"?

## 2. Ground every recommendation in this repo's current state

**Don't generalize from another project's conventions, an old audit doc, or a past commit — check the file/config/label/workflow as it exists right now.**

wp-critical-css looks similar to admitto in places (both are solarssk repos with milestones, labels, curated release notes) but diverges in specific ways that matter: bare `type:` commit prefixes here vs. admitto's scoped `type(scope):`, no `[Unreleased]` CHANGELOG section here vs. admitto's continuous one, a two-directory plugin/tests split that doesn't exist in admitto's structure at all. When adapting a pattern from elsewhere, verify the target repo's actual convention first (`git log`, the real label list via `gh label list`, the real branch-protection checks) rather than porting the source verbatim.

**The test:** could you point to the specific file or command output that confirms this, in *this* repo?

## 3. Surgical changes, one problem at a time

**Fix what's broken; don't refactor, rename, or "improve" what the task didn't ask about.**

Touch only what the task requires. Match existing conventions instead of introducing new ones (tabs for PHP, the existing NOSONAR/ignore-multicriteria pattern for accepted findings, the existing retry-loop style for flaky external calls). When something else looks off while you're in a file, mention it to the user rather than fixing it inline in the same PR — a security fix and an unrelated lint cleanup reviewed together is harder to verify than either reviewed alone.

**The test:** does every changed line trace directly back to the task in front of you?

## 4. You prepare; the user decides and merges

**Never merge a PR yourself — least of all a `release: vX.Y.Z` one, since merging it is now the entire release trigger.**

Every PR in this repo is merged by the user, not by an agent — prepare it, get its checks green, resolve review threads (via the GraphQL `resolveReviewThread` mutation — a plain reply does not clear a `BLOCKED` PR), and then wait. [`release.yml`](.github/workflows/release.yml) fires automatically off a `release: vX.Y.Z` commit landing on `main` and takes the rest of the way to GHCR/Docker Hub/GitHub Release from there with no further steps from anyone — so there is no separate tag-push confirmation to ask for anymore, but that also means the release PR itself deserves the scrutiny a manual publish step used to get: verify the version bump is correct and the four places it must match (`AGENTS.md`'s "Changelog and releases") actually match, *before* it's merged, not after.

**The test:** would you be comfortable with this specific PR merging and immediately, irreversibly publishing — because that's exactly what happens?

## 5. Compounding engineering

**When you (or the user) catch a mistake worth not repeating, write it down — in [AGENTS.md](AGENTS.md) if any agent should know it, here if it's Claude-Code-specific.**

This file and AGENTS.md's "Compounding rules" section exist because a mistake caught once and not written down gets made again by the next session with no memory of the first time. A milestone-per-PR mixup that orphaned three version numbers is why AGENTS.md now states the single-open-milestone rule explicitly instead of leaving it to be re-discovered.

**The test:** if the same situation comes up in a fresh session next month, does this rule stop the mistake before it happens?
