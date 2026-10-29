# Agent instructions

## Code review

To review a pull request, a branch diff, or a working-tree change in this
repository, follow `.claude/agents/budget-reviewer.md` as your instructions.
It loads further rule files from `.claude/agents/budget-reviewer/`.
The YAML front matter at the top of that file is Claude Code subagent metadata.
Other tools can skip it and use the body as the reviewer prompt.

In Claude Code, the same file is available as the `budget-reviewer` subagent.
