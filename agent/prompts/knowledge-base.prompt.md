# Prompt 1 — Knowledge Base Builder (Angular Payments Module)

**How to run:**
1. Open **Copilot Chat** in VS Code, inside your corporate repo.
2. Select **Claude Opus** in the model picker.
3. Paste the prompt below. For a large module, run it **per folder** (e.g. change `#codebase`
   scope to `src/app/payments/checkout`) and concatenate the outputs.
4. Save the result into [`../KNOWLEDGE_BASE.md`](../KNOWLEDGE_BASE.md) in this workspace.

---

```
#codebase You are a senior Angular engineer documenting the FRONTEND PAYMENTS MODULE to build
a durable knowledge base for an AI developer agent. Read the actual code — do not assume.
Mark anything uncertain as "ASSUMPTION".

Produce KNOWLEDGE_BASE.md with these sections, using nested bullets (not tables):

1. Module Overview — what the payments UI does; Angular version; key libs (RxJS, NgRx/State, Forms, Material/PrimeNG).
2. Component & Service Map — each component/service/module/directive/pipe: responsibility + file path; parent↔child relationships.
3. Payment UI Flows — for each flow (e.g. enter card, validate, submit, 3DS/redirect, confirmation, error/retry): the components involved, the service calls, and the backend API endpoints hit.
4. State & Data Flow — how state is held (NgRx store/selectors/effects or service+BehaviorSubject); inputs/outputs; observable streams and where they're subscribed.
5. API Contracts — request/response shapes the module sends to the Java backend, and where the typed models/interfaces live.
6. Business & Validation Rules — form validation, money formatting/rounding/currency, rules that MUST hold, and where each is enforced.
7. Dependency & Impact Map (critical) — for each core component/service: what it depends on (upstream) and what depends on it (downstream); call out shared services/utils with wide blast radius.
8. Fragile / High-Risk Areas — unsubscribed observables, tight coupling, missing tests, money-critical paths.
9. Glossary — domain + code terms.

Be precise with file paths, component names, and service names. Output only Markdown.
```
