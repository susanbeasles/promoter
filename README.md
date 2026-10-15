# promoter

A dumb promoter. It merges what the authorizer tells it to merge, nothing else.

## What it does

- Consumes an authorizer token for the `promote` action over a private service binding, then squash-merges
  the pull request through the promoter GitHub App with an installation token minted inside the Worker. GitHub
  signs the squash commit, so `main` stays linear and verified with no key infrastructure.

## What it does not do

- Decide. The authorizer verified the pipeline stages on the exact merge SHA before invoking it.
- Deploy, release or tag. Those are `deployer` and the release stage of the pipeline.
- Accept a `workflow_dispatch` or any request from the public internet.

## Where results are seen

The squash commit on `main` and the merged pull request. Nothing here is activated until its acceptance tests
pass and are shown in a pull request.
