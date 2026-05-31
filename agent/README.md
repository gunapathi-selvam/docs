# Payments Module — Agent Hub

A reusable kit of **agents + knowledge** for the **Angular frontend payments module**. Drop it into
your module repo and the agents work on your **live code**, using two Markdown knowledge docs as a
fast index + rulebook.

## What's in here

| File / folder | What it is |
|---|---|
| [`SETUP.md`](SETUP.md) | **Start here** — full migration & setup process (copy, prompts, load agents, assign tasks, refresh) |
| [`ONBOARDING.md`](ONBOARDING.md) | First-week guide for new joiners (freshers) |
| [`KNOWLEDGE_BASE.md`](KNOWLEDGE_BASE.md) | The module "brain" — fill via the prompt below |
| [`CODE_ANALYSIS.md`](CODE_ANALYSIS.md) | Risk/health catalogue — fill via the prompt below |
| [`prompts/`](prompts/) | The two Copilot+Opus prompts that generate the docs above |
| [`.claude/agents/`](.claude/agents/) | The three Claude Code agents |
| [`github-portable/`](github-portable/) | Copilot instruction files to copy into the repo's `.github/` |

## The three agents

| Agent | For | Use |
|---|---|---|
| [`@payment-dev`](.claude/agents/payment-dev.md) | You | Plan/implement a change + impact analysis ("what breaks if…") |
| [`@code-reviewer`](.claude/agents/code-reviewer.md) | You | Review a diff for risk / perf / RxJS leaks / dead code |
| [`@onboarding-guide`](.claude/agents/onboarding-guide.md) | Freshers | Teach the module, guided tours of flows |

## The mental model

```
   Your module repo (live Angular code)
   ┌──────────────────────────────────────────────────────────┐
   │  KNOWLEDGE_BASE.md  +  CODE_ANALYSIS.md   ← fast index + rules │
   │             │                                              │
   │   ┌─────────┼──────────────┬───────────────┐              │
   │  @payment-dev      @code-reviewer    @onboarding-guide      │
   │  (plan+impact+fix)   (review)         (teach freshers)      │
   │             │                                              │
   │        all read the LIVE CODE, sped up by the docs          │
   └──────────────────────────────────────────────────────────┘
        ▲ Copilot path: .github/copilot-instructions.md
          → assign issue to Copilot (cloud PR) / Copilot code review
```

- The **knowledge** is portable Markdown — share it anywhere (repo, wiki, Teams).
- An **agent** is just a tool (Claude Code *or* Copilot) reading that knowledge + the code.
- **Keep the docs fresh:** re-run the prompts after big changes so agents (and freshers) always
  reflect the current repo.

## Quick start

See [`SETUP.md`](SETUP.md) for the full process. In short:
1. Copy this hub's files into your module repo (see SETUP §1).
2. Run the two prompts in Copilot+Opus → paste output into the two `.md` docs (SETUP §2).
3. Open Claude Code in the repo → `@payment-dev`, `@code-reviewer`, `@onboarding-guide` (SETUP §3).
4. (Optional) copy `github-portable/` into `.github/` for the Copilot/GitHub path (SETUP §4).

## Note on GitHub + Claude

The GitHub surface uses **Copilot** (your org plan). A *Claude*-powered `@claude` GitHub Action is
possible but needs a separate `ANTHROPIC_API_KEY` org secret — not included. Ask if you get a key.
