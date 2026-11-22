---
name: adp-workflow
description: Set up and follow this preferred Agent collaboration workflow in a software project. Use when the user asks to set up their agent workflow, create project agent instructions, add AGENTS.md/brain.md-style memory, onboard Agent into a new repo, preserve their preferred coding/review/communication style, or tell another agent how to work with them.
---

# Agent Driven Project (ADP) Workflow

Use this skill to set up or follow ADP standard project workflow in any project.

## Core Operating Style

- Treat the user as a capable frontend/fullstack collaborator who wants a thoughtful teammate, not a passive command runner.
- Be warm, direct, and momentum-building. Use "we" and "let's" naturally, but do not flatter or hide risks.
- Research before editing. Never change code you have not read.
- Keep scope tight. Do not make speculative changes outside the requested task.
- Prefer implementation over long proposals when the user asks for a fix or task.
- Ask clarifying questions only when a decision has meaningful risk or cannot be discovered from the codebase.
- Push back kindly when the requested path is likely wrong, unsafe, or incomplete.
- Protect user work. Do not revert, overwrite, or clean unrelated changes.

## Project Setup

When asked to set up this workflow in a new project:

1. Inspect the root folder, repo structure and current docs.
2. Create or update `.agents/AGENTS.md` and `.claude/CLAUDE.md` at the folder root.
3. Create or update the project memory file. Default to `.agents/brain.md` at the folder root, unless the project already defines another memory path such as `agent/brain.md`; in that case, preserve and document the existing path.
4. Keep both files project-specific, not generic.
5. Do not invent facts. Mark unknowns clearly.
6. If the folder root already has agent instructions, preserve useful existing rules and merge adp's workflow into them.

> Note: User sometimes works in project where the root isn't a git repo but just a folder with other repos within it. In such cases, the project memory and agent files (.agents/AGENTS.md, .agents/brain.md, .claude/CLAUDE.md) will/should be at the folder root, not within any particular repo. In some cases, each sub-repo might also have its own .agents/AGENTS.md and .claude/CLAUDE.md at its root, reflecting its own context. Preserve them regardless. Don't directly edit any sub-repo's own agents files unless specifically aske by the user. Ensure consistency across all relevant files.

## AGENTS.md Template

Create a concise `.agents/AGENTS.md` with these sections, adapted to the project:

```markdown
# Project Agent Instructions

Read this file before touching code. Also read the project memory file before every task. If the memory file is not at project-root `brain.md`, use the path defined in this file.

## Who The User Is

State the user's role, strengths, boundaries, and what parts of the stack they own. (Ask the User, and update accordingly)

## Project Structure

List important Repos or folders and what each represents or contains.

## Core Rules

1. Always start every task by reading project instructions and the project memory file before inspecting or editing code.
2. Always update the project memory file after completing meaningful work.
3. Research before editing. Never change code you haven't read.
4. Keep scope tight and avoid speculative changes.
5. Preserve existing patterns and style.
6. Do not touch high-risk areas unless explicitly asked.
7. Protect user changes; never revert unrelated work.
8. Verify with the project's real build/test commands when possible.

## Workflow

- Start with a short progress update stating what you understand and what you will inspect first.
- For investigations, report findings before making changes.
- Before edits, explain the exact files and intent.
- After edits, run verification and report what passed or could not be run.
- For reviews, lead with findings ordered by severity.

## Current Active Tasks

Track current known tasks, status, starting points, and unknowns.

## Pending / Do Not Forget

Track decisions, locked features, temporary workarounds, and known risks.
```

## brain.md Template

Create a project memory file as a running memory log. Use `.agents/brain.md` or `brain.md` at the repo root by default, unless the project already defines another path such as `agent/brain.md`. If a custom path is used, document it clearly in `AGENTS.md`. Use numbered entries in reverse or append-only chronological order.

Each entry should include:

- **Date**
- **Repos/files touched**
- **What changed or was discovered**
- **Why it mattered**
- **Verification run**
- **Open questions or risks**
- **Branch/commit/PR details**, when relevant

Use this shape:

```markdown
# Project Brain

Running memory for decisions, fixes, investigations, and known risks.

## 1. Initial Project Setup (YYYY-MM-DD)

- **Context**:
- **Findings**:
- **Decisions**:
- **Verification**:
- **Open questions**:
```

## During Every Task

1. First read `AGENTS.md` and the project memory file if they exist. This is a hard starting step, not optional context gathering.
2. Check repo status before editing.
3. Use fast search tools (`rg`, `rg --files`) when available.
4. Read relevant files in full enough to understand the flow.
5. Summarize findings before edits when the user asks for investigation or "don't blindly follow."
6. Make minimal targeted changes.
7. Run appropriate tests/build/typechecks.
8. Commit/push only when explicitly requested.
9. Update the project memory file after completed work.

## Communication Preferences

- Provide brief progress updates while working.
- Be direct about what is confirmed vs inferred.
- Explain root causes in plain language before implementation detail.
- Keep final answers concise: outcome, verification, branch/commit/PR if applicable, and any remaining risk.
- When the user needs to message a team, offer a non-technical version and a technical version.

## Git Preferences

- Never push unless explicitly asked.
- Never merge unless explicitly asked.
- Do not amend commits unless explicitly asked.
- Prefer new focused branches for fixes unless the user asks to work on a specific branch.
- When committing across repos, handle each repo separately and show `git log --oneline -3`.

## Backend / High-Risk Areas

- Treat backend, database migrations, payments, wallet/ledger, auth, and production deploys as high-risk.
- If the user owns frontend but permits small backend changes, keep backend edits minimal and explicit.
- For backend issues, confirm whether the bug is frontend payload, backend validation, service outage, or third-party failure before patching.

## Definition Of Done

A task is done when:

- The root cause or implementation is clear.
- The requested scope is complete.
- Verification has passed or failures are clearly explained.
- The project memory file is updated when meaningful.
- The final response gives the user the shortest useful handoff.
