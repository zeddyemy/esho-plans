---
name: adp-plan
description: Use when the user asks to create a plan, implementation plan, technical plan, project plan, feature plan, architecture plan, migration plan, execution plan, roadmap, or planning document intended for both human developers and AI coding agents. Create or update workspace implementation plans as standalone HTML files in a .plans directory.
---

# ADP Plan

## Core Rule

Create plans as standalone HTML documents inside the appropriate workspace `.plans/` directory.

Do not write the plan immediately if important context is missing. Ask focused discovery questions first, then create the plan once the requirements, constraints, and expected outcome are clear enough.

## Workflow

1. Identify the workspace and repository layout.
   - Determine whether the current directory is a workspace, a Git repository, or both.
   - Prefer the parent workspace `.plans/` directory when a non-Git workspace contains one or more Git repositories.
   - If the current project is also the workspace, use that project's `.plans/` directory.
   - Create `.plans/` only when needed for the requested plan.
   - Done when the destination workspace and plan directory are known.

2. Ask discovery questions.
   - Ask enough questions to understand the goal, users, scope, constraints, stack, risks, and desired level of detail.
   - Keep questions practical and grouped.
   - Continue only when the plan can be useful to both humans and agents.
   - If the user asks for a quick plan or provides enough context, proceed with clearly marked assumptions.
   - Done when the requirements support a useful plan.

3. Choose a descriptive filename.
   - Use lowercase kebab-case.
   - End with `.html`.
   - Prefer names like `authentication-redesign.html`, `sdk-architecture.html`, or `payment-flow.html`.
   - Update an existing relevant plan instead of creating duplicates when the user is revising a plan.
   - Done when the plan has one stable path.

4. Write a specification-quality HTML plan.
   - Make it detailed yet clear and concise enough for another developer or AI coding agent to implement from.
   - Keep it understandable for team review.
   - Distinguish known facts, assumptions, decisions, open questions, and implementation tasks.
   - Done when a developer can implement and verify the work from the plan.

5. Verify the output.
   - Confirm the HTML file exists in `.plans/`.
   - Check that major sections, diagrams, and code blocks render as valid HTML.
   - If using Mermaid, include the Mermaid browser script and valid Mermaid code blocks.
   - Done when the saved HTML renders the plan and its diagrams.

6. Publish the plan.
   - Run `esho-plans publish <path> --note "<one line describing what changed>" --json`. If the installed binary is outside `PATH`, use `~/.local/bin/esho-plans`.
   - Pass `--shared` only when the user explicitly asks to make this plan available to the client. With no visibility flag, new plans are internal and updates keep the existing visibility.
   - Report the private URL and any client URL returned. The CLI records the project ID and private URLs in `.plans/.postplan.json`. Point to this record once in project memory.
   - On exit 2, use the printed choices to ask for the project, then rerun with `--project <id>`. If the command is unavailable or fails otherwise, report why and confirm the local plan was saved. Avoid repeated retries. `esho-plans sync` can publish saved changes later.
   - Done when the publish receipt is reported or the local-only result is explained.

## Recommended Plan Sections

Include sections that fit the task. Do not include empty boilerplate.

- Overview
- Goals
- Non-goals
- Current state
- Proposed solution
- Requirements
- Assumptions
- Constraints
- Architecture
- Data model
- API design
- User flows
- Component or module responsibilities
- Directory structure
- Implementation phases
- Test plan
- Rollout plan
- Risks and mitigations
- Edge cases
- Open questions
- Future improvements
- Revision history

## HTML Style

Make the plan feel like a polished technical specification, not a marketing page or dashboard.

Use:

- black or near-black background;
- white or light-gray text;
- readable typography;
- generous spacing;
- constrained line length;
- simple tables;
- syntax-highlighted code blocks when useful;
- Mermaid diagrams when they clarify architecture, flows, states, or relationships;
- internal navigation only when the document is long enough to benefit from it.

Avoid:

- decorative hero sections;
- excessive cards;
- nested cards;
- unnecessary pills or badges;
- oversized headings;
- loud color palettes;
- ornamental gradients;
- UI labels that do not improve comprehension;
- filler sections.

Before publishing, verify that the plan is one standalone UTF-8 HTML file under 1.5 MB. Keep CSS in `<style>`. Use inline scripts or scripts from `cdn.jsdelivr.net`, `unpkg.com` or `cdnjs.cloudflare.com`. Use HTTPS or inline data URLs for images. The reader blocks fetch/XHR, forms and nested frames. If styling the body text globally, let Mermaid labels inherit their own color with a selector scoped to `.mermaid`.

## Content Standards

Write for two audiences at once:

- human developers who need to understand the project, discuss tradeoffs, and review the approach;
- AI coding agents that need clear, executable instructions.

Prefer precise implementation guidance over vague strategy. Include examples, paths, interfaces, schemas, and commands when they reduce ambiguity.

Use diagrams only when they communicate better than prose. Good Mermaid candidates include:

- architecture diagrams;
- sequence diagrams;
- user or data flowcharts;
- entity relationship diagrams;
- state diagrams;
- dependency graphs.

## Living Document Policy

Treat plans as living documents.

When implementation reveals new information or requirements change:

- update the existing plan whenever practical;
- preserve still-accurate completed sections;
- mark meaningful changes in a revision history;
- keep the plan's revision history current, since the hub stores only the latest HTML;
- keep implementation aligned with the latest plan.

Avoid creating `v2`, `final`, or duplicate plans unless the user explicitly asks for a separate document.
