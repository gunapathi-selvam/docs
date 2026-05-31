<!--
  PORTABLE FILE — copy this into your corporate repo at:
      .github/instructions/payments.instructions.md

  Copilot supports path-scoped instruction files under .github/instructions/ with an `applyTo`
  glob in frontmatter. This one fires ONLY when Copilot touches files in the payments module,
  so it won't add noise elsewhere in the repo.

  Adjust the `applyTo` glob below to match your real module path.
-->
---
applyTo: "src/app/payments/**"
---

# Payments Module — Path-Scoped Copilot Instructions

These rules apply specifically to the Angular payments module.

- **Money & correctness:** preserve currency/rounding/precision; guard against double-submit;
  never weaken form validation; respect documented business invariants in `KNOWLEDGE_BASE.md`.
- **Impact awareness:** before editing a shared payment service, check what depends on it
  (Dependency & Impact Map) and note breakage risk in the PR description.
- **RxJS:** use `async` pipe or `takeUntil(destroy$)`; no nested or leaking subscriptions.
- **Change detection:** `OnPush`; no heavy work in templates; `trackBy` on lists.
- **Typing:** no `any`; use the module's typed request/response models.
- **Tests:** add/update unit tests for any changed payment flow; cover error + edge cases
  (declined payment, validation failure, network error/retry).
- **Accessibility:** payment forms must have proper labels, focus management, and error messaging.
