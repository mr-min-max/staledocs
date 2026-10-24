# StaleDocs walkthrough production script

This is the reviewed 80-second narrative for a future full walkthrough. The
timing matches `docs/demo/staledocs-walkthrough.vtt` and the five checked-in
animation frames.

The checked-in README animation is deterministic and does not claim to invoke
Codex. It renders the accepted `createUser` fixture, not a recorded model run,
provider call, or repository write. A future full recording may show a live
Codex host workflow in a fresh disposable repository, but that recording must
follow this script and the checklist.

## 0-10s: code changed

Show the exact source change:

```text
createUser(email) -> createUser(email, role)
```

Say or caption: "One public function now requires a role. This is the only
code change in the example."

Do not show a personal terminal, account details, or a private repository.

## 10-25s: two docs affected

Show the changed function leading only to the example's `README.md` and `API.md`.

Say or caption: "StaleDocs analyzes the change first and narrows the documentation
work to two files. It does not send an unbounded repository through this
demonstration path."

Do not add invented counts, scores, timing, or quality claims.

## 25-50s: bounded host draft

Show relevant context entering a host-owned Markdown draft. Keep
`prepare_documentation_update` visible as secondary evidence and show
`No provider calls`.

Say or caption: "StaleDocs prepares bounded context. The host owns the draft. In
this deterministic animation, StaleDocs makes no provider call and does not claim
to invoke Codex. A live Codex host workflow would use the same path."

Do not present the host-owned draft as an automatic StaleDocs write.

## 50-70s: draft validated

Show the focused change in both the example's `README.md` and `API.md`:

```diff
- createUser(email)
+ createUser(email, role)
```

Keep `validate_documentation_draft` visible and show one green validation
mark.

Say or caption: "StaleDocs validates the exact candidate for both files. Validation
checks the bounded draft; it does not replace maintainer review."

## 70-80s: you review

Show the validated draft stopping before the repository. Keep
`No repository writes`, `You decide what is applied`, `Review the diff`, and
`Public beta` available in the final presentation or captions.

Say or caption: "Review the diff. Nothing is written by this provider-free
workflow. You decide whether the approved Markdown is applied."

The MP4 remains an optional future recording. The checked-in animation is the
small deterministic README asset; any live recording is reviewed separately
before upload.
