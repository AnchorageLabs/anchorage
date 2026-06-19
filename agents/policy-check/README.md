# policy-check (Fase 5 · F2)

Architecture-governance gate. Runs between `apply-code` and `run-tests`. It
evaluates the run's diff against the repo's committed `.anchorage/constraints.yaml`
graph rules using the persisted import graph — **zero LLM tokens**. A hard
violation emits a `code.revision.request`, which the existing feedback loop
bounces back to the coder, so architecture violations are fixed before tests run
or a human sees the PR.

Task type: `policy.check` · capability: `workspace.read`.

## `.anchorage/constraints.yaml`

Committed in the target repo. Today only the `forbid-import` (graph-rule) class
is enforced; unknown `type`s are skipped (forward-compatible).

```yaml
rules:
  - id: no-db-in-controllers
    type: forbid-import
    from: "src/controllers/**"   # importing side (glob: ** any depth, * one segment)
    to: "src/db/**"              # forbidden imported side
    severity: hard               # hard = revision request (blocks); soft = advisory
  - id: frontend-uses-client-layer
    type: forbid-import
    from: "src/pages/**"
    to: "src/server/**"
    severity: hard
```

A repo without a `constraints.yaml` is unconstrained — the step no-ops. The
evaluator only flags imports introduced by the **current diff**, and fails open
(no violations) if the index can't be built. Bootstrapping: the cartographer can
propose rules from observed structure for a human to confirm in a PR.
