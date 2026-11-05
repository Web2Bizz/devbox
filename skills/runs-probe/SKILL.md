---
name: runs-probe
description: Inspect the run worktree with native:git.recon before the prototype planner advances a step.
allowed-tools:
  - native:git.recon
---

When a run starts, call `native:git.recon` to read the worktree HEAD and the
dirty file list. Use the result to decide whether the next step is safe; never
commit or reset from this skill.
