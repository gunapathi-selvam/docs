# Prompt 2 — Code Health & Risk Analysis (Angular Payments Module)

**How to run:**
1. Open **Copilot Chat** in VS Code, inside your corporate repo.
2. Select **Claude Opus** in the model picker.
3. Paste the prompt below. For a large module, run it **per folder** and concatenate.
4. Save the result into [`../CODE_ANALYSIS.md`](../CODE_ANALYSIS.md) in this workspace.

---

```
#codebase You are a principal Angular engineer reviewing the FRONTEND PAYMENTS MODULE for
code health and risk. Read the real code. Every finding must cite a file path (and
component/line where possible). No generic advice you can't tie to actual code.

Produce CODE_ANALYSIS.md, nested bullets, findings ordered High → Medium → Low per section:

1. Breaking-Risk Hotspots — unhandled errors, money/rounding/currency bugs, missing form validation, double-submit on payment, unsafe null/optional handling, race conditions on async submit.
2. Performance Concerns — change-detection issues (no OnPush, heavy bindings/functions in templates), missing trackBy, unnecessary re-renders, large/blocking work, un-lazy-loaded routes, oversized bundles.
3. RxJS / Memory Safety — observables subscribed without unsubscribe/takeUntil/async-pipe, nested subscriptions, shared subjects leaking — each with location and fix.
4. Complexity / Maintainability — oversized components/services, deep template nesting, duplicated logic, fat methods; how to split.
5. Dead / Unused Code — unused components/services/imports/inputs, unreachable branches, commented-out blocks. Mark confidence (Certain / Likely / Verify).
6. Good-Practice & Correctness Gaps — typing (avoid any), error handling, missing logging on payment paths, missing/weak unit tests on critical flows, accessibility on payment forms.
7. Prioritized Recommendations — single ranked list: what to change, file(s), effort (S/M/L), risk reduced.

Be specific and verifiable. Output only Markdown.
```
