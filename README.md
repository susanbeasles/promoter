# promoter

The only writer of `main`. It builds a shadow candidate for a pull request, and after the pipeline passed on
that exact candidate, fast-forwards `main` to it and tags it with machine-readable provenance. It decides
nothing: the authorizer decides and calls it over a private service binding. Contract:
`infra-root/docs/adr/0001-pipeline-surround.md` section 1.

## What it does

- `prepare({v:1, action:'shadow.prepare', subject:{repo, repo_id, pr, head_sha}, requested_by})`: checks the PR
  is open, into `main`, from this repository, at `head_sha`; merges the head onto the current `main` tip
  server-side on `shadow/pr-<n>`; replaces that merge with a single-parent squash commit carrying the merged
  tree, the PR title and body, and trailers (`Promoted-PR`, `Promoted-Head`, `Shadow-Base`, `Co-authored-by`);
  records `{head, base, tree, candidate}`. The push to `shadow/pr-<n>` runs the pipeline on the candidate.
- `promote({v:1, action:'promote', subject:{repo, repo_id, pr, candidate_sha}, evidence, requested_by})`:
  refuses unless the candidate matches the record, the PR head is unchanged, the candidate's tree and single
  parent are as recorded, and `main` is still at the recorded base; then `PATCH refs/heads/main` with
  `force: false` (GitHub rejects anything but a fast-forward), reads `main` back, creates the annotated tag
  `promote/pr-<n>-<12 hex>` whose message is canonical JSON `promotion-provenance/v1` plus its sha256,
  comments on and closes the PR, and deletes the shadow branch.
- When `main` moved after the candidate was built it answers `stale_base` and has already rebuilt the
  candidate on the new tip (`candidate_sha` in the refusal); the pipeline reruns on it. A stale candidate can
  never be promoted.
- Every call is idempotent. Promotions of one repository are serialized in that repository's Durable
  Object. Follow-ups that fail after `main` moved stay pending and are retried by the object's alarm.

## What it does not do

- Decide, verify checks or attestations (the authorizer does and passes its evidence for the tag).
- Force-push `main`, merge with a merge commit, or touch any repository other than the one in the request.
- Accept HTTP requests: there is no route and no fetch handler beyond a 404.

## Refusal codes

`bad_request`, `bad_shape`, `unknown_key`, `bad_version`, `bad_action`, `bad_subject`, `bad_repo`,
`bad_repo_id`, `bad_pr`, `bad_sha`, `bad_evidence`, `bad_requested_by`, `too_large`, `bad_encoding`,
`bad_json`, `bad_config`, `bad_key`, `not_open`, `wrong_base`, `head_moved`, `repo_mismatch`, `is_fork`,
`conflict`, `nothing_to_promote`, `no_shadow`, `stale_base`, `candidate_mismatch`, `tree_mismatch`,
`not_fast_forward`, `readback_mismatch`, `api_error`, `internal`. Every refusal is a value with status 403.

## Where results are seen

`main`, the `promote/*` tags (verify with `git cat-file -p <tag>`: the JSON's sha256 is on the last line), the
PR comment, and the caretaker's commit ledger, which flags any `main` commit without a provenance tag.

## Setup the owner does once

1. Create the promoter GitHub App (repository permissions: Contents write, Pull requests write; no events)
   and install it on the control-plane repositories. Put its id and installation id in `wrangler.jsonc`.
2. Store its private key as PKCS#8 in Secrets Store as `PROMOTER_APP_KEY` (through the seed; GitHub
   downloads PKCS#1, convert with `openssl pkcs8 -topk8 -nocrypt`).
3. Rulesets: the App is the only bypass actor allowed to update `main`, may create `shadow/*` branches, and
   may create `promote/*` tags; tags stay immutable.
4. VERIFY on the first promotion: GitHub signs commits created by an App through the git-data API (the
   candidate must show Verified, or the signed-commits rule refuses it).

## Develop

```
npm ci --ignore-scripts
npm run check      # tsc strict for src (workers types) and tests (node types), then node --test
```

Tests drive the real promotion code against an in-memory GitHub with git semantics (refs, parents, trees,
server-side merges, fast-forward-only updates, annotated tags). Nothing here is activated.
