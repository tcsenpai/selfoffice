---
name: sync-upstream
description: Use when the automatic upstream sync (sync-upstream.yml) fails or conflicts, or to merge genspark-ai/genoffice into SelfOffice by hand. Not for ordinary feature work.
---

# Manual upstream sync (SelfOffice <- genspark-ai/genoffice)

SelfOffice is a **fork of genoffice and stays one**: SelfOffice brand, `@selfoffice/*`
scope, BYOK / local AI, nothing locked to Genspark. This skill is the manual fallback for
`.github/workflows/sync-upstream.yml` (red run, conflict, or a long-stale fork).

## The rule

| Upstream change                                                                                           | What we do                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Feature, fix, new test, refactor                                                                          | Take it                                                                                                           |
| Removes something we have (code, key, export, option, docs section)                                       | **Keep ours**, unless it is a security fix                                                                        |
| Genspark account / sign-in / `gsk` CLI / GenTeam / cloud projects / analytics / hosted "native admission" | Drop that part, keep the rest of the change                                                                       |
| Anything in `ee/` or `.github/workflows`                                                                  | Never merged (separate license / our CI is ours); port workflow changes by hand if wanted                         |
| Brand                                                                                                     | SelfOffice, never GenOffice. Persisted-in-file identifiers stay (see `PROTECTED` in `tools/rebrand-upstream.mjs`) |

A removal that is really a _move_ (e.g. upstream moved ribbon keys into
`packages/i18n/src/common-ribbon.ts` and a test forbids re-declaring them in the shards)
is a refactor: take it, and put our value (`'AI'`, not `'Genspark'`) in the new place.

## How the sync works (why conflicts are rare)

`upstream-rebranded` is a branch holding upstream `main` with the rebrand applied to the whole
tree, one commit per sync, each with two parents: the previous mirror commit and the upstream
commit it came from (`tools/mirror-upstream.sh`, `tools/rebrand-upstream.mjs --tree`). It carries
no `ee/` and no `.github/workflows`. Merging it into main has a real, already-rebranded merge
base, so the `@genoffice` -> `@selfoffice` rename is never a conflict; only real divergence is.

Never `git merge upstream/main` directly: the brand rename alone made ~200 files conflict.

## Procedure

```bash
export LC_ALL=C                      # git messages in English (the scripts parse them)
git remote add upstream https://github.com/genspark-ai/genoffice.git 2>/dev/null
git fetch upstream main && git fetch origin
git checkout -b selfoffice/sync-upstream-manual origin/main

# 1. refresh the mirror (uses origin/upstream-rebranded as the previous tip, or bootstraps)
tip=$(tools/mirror-upstream.sh upstream/main)
prev=$(git rev-parse "$tip^1")
# first run / squashed sync PR: make the previous mirror commit an ancestor, tree untouched
git merge-base --is-ancestor "$prev" HEAD || git merge -s ours -m "build: record rebranded upstream base" "$prev"

# 2. merge
git merge --no-commit --no-ff "$tip"
git status --porcelain | grep -E '^(UU|DU|UD|AA)'
```

Resolve by status:

- `DU` (we deleted, upstream changed): stays deleted -> `git rm <file>`.
- `UD` (upstream deleted, we changed): keep ours -> `git add <file>`.
- `UU`: per hunk, apply the rule above. `<<<<<<< HEAD` is ours. Read both sides; keep both when
  they touch different things.
- Files upstream deleted that merged cleanly (we never touched them) but that we still use:
  `git diff --name-only --diff-filter=D "$prev" "$tip"`, restore with `git checkout HEAD -- <file>`.
- `package-lock.json`: `git checkout --ours package-lock.json && npm install --package-lock-only --ignore-scripts`.
- Many conflicts of the same shape (e.g. 44 i18n shards): check one, then resolve mechanically.

## After resolving (all of these failed on the 2026-11-07 sync until fixed)

```bash
npm ci --ignore-scripts
npm run typecheck --workspaces --if-present --include-workspace-root=false   # continues past failures
node tools/build-font-aliases.mjs        # fonts.generated.css: file renames reorder the manifest
node tools/truths-coverage.mjs           # docs/word-truths-coverage.md
# layout goldens hash HTML that contains the (rebranded) font family names, so they need regenerating
(cd apps/docs && PARA_LAYOUT_GOLDEN_UPDATE=1 npx vitest run tests/para-layout-spec-golden.test.ts \
  && npx vitest run -u tests/font-metric-baseline.test.ts && npx prettier --write tests/fixtures)
npm run check:inline-rules check:font-metrics-provenance check:generated-fonts check:word-truths \
  check:skill-version check:help-langs licenses check:theme-colors   # inline-rules / provenance / theme-colors are diff-based: pass FORMAT_BASE_REF=<mirror tip>, or skip (ci.yml skips them on sync merges)
node tools/format-changed.mjs --check    # prettier --write what it lists
env -u EXA_API_KEY npm test              # a locally set search key makes the fallback tests fail
```

Typical post-merge breakage to grep for:

- upstream code using Genspark pieces we removed (`gskApiKey`, `GensparkMark` -> our `AiMark`,
  `useGsk`, `AI_SEARCH_DISABLE_GSK`, `native-admission`, `genspark` as a provider/search default
  -> `free` / BYOK). Compare mention counts with `git grep -c -iP 'gsk\w*|genspark' HEAD` vs the index.
- new upstream features wired to a Genspark key (e.g. AI file naming): make provider resolution
  BYOK-only, reusing `resolveAiSettings` / `activeProvider`, and keep the feature working.
- mixed-case brand variants (`Genoffice`): add the case to `rebrand()` in the tool and rebuild the mirror
  (`git branch -D upstream-rebranded` then rerun `tools/mirror-upstream.sh`).
- upstream tests that now fail only because we default differently (search fallback `free`, models that
  route to the Responses API): fix the test to our behavior.

## Commit and push

```bash
git add -A
git commit -m "build: merge upstream/main ($(git rev-parse --short upstream/main))"   # message prefix feeds auto-release
git push origin upstream-rebranded                      # the mirror must be on origin (fast-forward)
git checkout main && git merge --ff-only selfoffice/sync-upstream-manual && git push origin main
```

Keep `upstream-rebranded` pushed: the next automatic run resumes from `origin/upstream-rebranded`,
and `git log HEAD..upstream/main` must be empty afterwards (the mirror commit has the upstream
commit as 2nd parent, which is what marks it as merged).

If the manual merge is large, split conflict resolution across files in parallel (non-overlapping
file sets, no `git add` by the workers) and run the gates yourself at the end.
