# SETUP & MIGRATION GUIDE — Payments Module Agents

This is the complete, step-by-step process to move this agent hub into your **Angular payments
module repo** and start using it. Do the steps in order. ⏱ ≈ 30–45 min the first time.

> **Key idea:** the agents run **inside your module repo**, so they read your **live code**
> directly. The two `.md` knowledge docs make them faster and enforce your documented rules — they
> are *not* a replacement for the code.

---

## 0. Prerequisites

- VS Code open on your **payments module repo** (the real Angular code).
- One (or both) of:
  - **Claude Code** installed (for the `@payment-dev` / `@code-reviewer` / `@onboarding-guide` agents).
  - **GitHub Copilot** (your org plan) for the GitHub/Copilot path.
- Git working tree clean-ish (so generated changes are easy to review).

---

## 1. What to copy, and where

Copy these from this hub into your **module repo root**:

| From this hub | Copy to (in your module repo) | Purpose |
|---|---|---|
| `.claude/agents/*.md` | `<repo>/.claude/agents/` | The 3 Claude Code agents |
| `KNOWLEDGE_BASE.md` | `<repo>/KNOWLEDGE_BASE.md` | Module knowledge (the "brain") |
| `CODE_ANALYSIS.md` | `<repo>/CODE_ANALYSIS.md` | Risk/health catalogue |
| `prompts/` | `<repo>/prompts/` (optional) | So you can regenerate the docs later |
| `github-portable/copilot-instructions.md` | `<repo>/.github/copilot-instructions.md` | Copilot guidance (all surfaces) |
| `github-portable/payments.instructions.md` | `<repo>/.github/instructions/payments.instructions.md` | Path-scoped Copilot rules |

> **Tip:** if you can't commit AI config to the corporate repo, keep `.claude/`, `KNOWLEDGE_BASE.md`
> and `CODE_ANALYSIS.md` **untracked** (add them to `.gitignore`). The agents still work locally;
> they just won't be shared via git.

---

## 2. Generate the knowledge base content (the prompts)

The two files arrive as placeholders. Fill them once, refresh periodically.

1. In VS Code, open **Copilot Chat** → in the model picker choose **Claude Opus**.
2. **Knowledge base:** paste the prompt from [`prompts/knowledge-base.prompt.md`](prompts/knowledge-base.prompt.md).
   - It starts with `#codebase` so Copilot reads the repo. For a big module, run it **per folder**
     (e.g. change scope to `src/app/payments/checkout`) and stitch the sections together.
   - Copy the Markdown output and **paste it into `KNOWLEDGE_BASE.md`**, replacing everything under
     the `<!-- PASTE ... -->` line.
3. **Code analysis:** repeat with [`prompts/code-analysis.prompt.md`](prompts/code-analysis.prompt.md)
   → paste into `CODE_ANALYSIS.md`.
4. Skim the result. Fix anything obviously wrong (the prompts ask the model to mark guesses as
   "ASSUMPTION" — resolve those). This doc is now your source of truth, so accuracy matters.

---

## 3. Load & use the agents in VS Code (Claude Code)

Claude Code **auto-discovers** any `.md` file in `.claude/agents/` when you open the repo.

1. Open the repo in VS Code and start **Claude Code** (extension panel, or `claude` in the terminal).
2. Invoke an agent by name:
   - `@payment-dev add a coupon field to the checkout form` → it locates the files, plans the change,
     runs impact analysis, and (if you tell it to go ahead) implements it.
   - `@code-reviewer review my staged changes` → it reads your `git diff` and flags issues.
   - `@onboarding-guide walk me through the refund flow` → guided explanation for a new joiner.
3. To list available agents, type `/agents`.

> The agents read your live code **and** the KB. With the KB filled in, responses are faster and
> respect your documented money/validation rules. Without it, they still work from code (slower).

---

## 4. Assign a task — two ways

**A) Locally in VS Code (works on your local files now):**
- Claude Code: `@payment-dev implement <task>` → review its plan → "go ahead" → it edits → you commit.
- Copilot agent mode / Chat: ask it to make the change; it follows `copilot-instructions.md`.

**B) On GitHub via Copilot (runs in the cloud, opens a PR):**
1. Create a GitHub **issue** describing the task.
2. **Assign the issue to Copilot.**
3. Copilot reads `copilot-instructions.md` + `payments.instructions.md`, makes changes on a branch,
   and **opens a pull request**.
4. Review the PR. With **Copilot code review** enabled (repo/org setting), every PR also gets an
   automatic review against your payment rules.

> Remember: **GitHub issue → cloud PR** (you review later). **VS Code → local edits** (you watch it).

---

## 5. Update / refresh the knowledge base

The agents are only as good as the docs. Keep them current:

- **After any significant change** (new flow, refactor, new component): re-run the relevant prompt
  (scope it to the changed folder) and update the matching section of the doc.
- **Lightweight option:** ask `@payment-dev` (or Copilot) *"update the Component & Service Map and
  Dependency & Impact Map in KNOWLEDGE_BASE.md to match the current code"* and review the diff.
- Treat the docs like code: review the change before committing so freshers always read accurate,
  up-to-date repo details.

---

## 6. Quick verification checklist

- [ ] `KNOWLEDGE_BASE.md` and `CODE_ANALYSIS.md` have real content (no `_(pending)_` left).
- [ ] `/agents` lists `payment-dev`, `code-reviewer`, `onboarding-guide`.
- [ ] `@payment-dev` "what breaks if I change the refund service?" → cites real components from the Impact Map.
- [ ] `@code-reviewer` on a small diff → returns located, ranked findings.
- [ ] `@onboarding-guide` "explain the checkout flow" → beginner-friendly, points to real files.
- [ ] (Copilot) `.github/copilot-instructions.md` present → open a test PR and confirm the review reflects payment rules.

---

## Troubleshooting

- **Agent says the KB is empty** → you haven't pasted the generated content into the `.md` files (step 2).
- **`@agent` not found** → the `.md` files aren't in `<repo>/.claude/agents/`, or Claude Code was
  started outside the repo. Run `/agents` to confirm discovery.
- **Copilot ignores the rules** → file must be exactly `.github/copilot-instructions.md`; for the
  path-scoped file, check the `applyTo` glob matches your real module path.
- **Copilot model has no Opus** → your org admin must enable Claude models for Copilot.
