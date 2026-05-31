<!--
  PORTABLE FILE — copy this into your corporate repo at:  .github/copilot-instructions.md

  GitHub Copilot automatically loads .github/copilot-instructions.md and applies it to
  Copilot Chat, the Copilot coding agent (when you assign an issue to Copilot), and
  Copilot code review on pull requests.
-->

# Copilot Instructions — Payments Frontend Module (Angular)

## Scope & role
You are assisting on the **Angular frontend payments module**. The backend is Java and is
**out of scope** — do not modify or assume backend behavior beyond documented API contracts.

## Before making changes
- Consult the module knowledge base (`KNOWLEDGE_BASE.md`) and analysis (`CODE_ANALYSIS.md`) if
  present in the repo; respect the documented component/service map, payment flows, and the
  **Dependency & Impact Map**. When a change touches a shared service, call out downstream impact.

## Payment correctness (non-negotiable)
- Never break money-handling invariants: correct **currency**, **rounding**, and amount precision.
- Prevent **double-submit** on payment actions (disable/guard the submit path).
- Keep form **validation** intact; never weaken validation on payment inputs.
- Preserve idempotency/retry behavior where it exists.

## Angular conventions
- Prefer `ChangeDetectionStrategy.OnPush`; avoid function calls / heavy expressions in templates.
- Use `trackBy` on `*ngFor` over lists.
- Manage subscriptions safely: prefer the `async` pipe, or `takeUntil(destroy$)` — no leaking
  subscriptions or nested `subscribe`.
- Strong typing: avoid `any`; use the module's typed models/interfaces.
- Lazy-load feature routes where appropriate.

## Quality bar
- Add/maintain unit tests for payment-critical logic and flows.
- Add error handling and logging on payment paths.
- Keep components small; extract logic into services where it grows.
- Ensure accessibility on payment forms (labels, focus, error announcements).
