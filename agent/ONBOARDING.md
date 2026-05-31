# Onboarding Guide — Payments Frontend Module (Angular)

Welcome! 👋 This guide gets a new joiner productive on the **Angular payments module** without a
manual walkthrough. You'll learn the module by **asking an agent** and reading the knowledge base,
both of which stay up to date with the real code.

---

## Your first hour

1. **Open the repo** in VS Code and make sure the project builds/runs locally.
2. **Read [`KNOWLEDGE_BASE.md`](KNOWLEDGE_BASE.md)** — start with sections 1–3 (Overview,
   Component & Service Map, Payment UI Flows). This is your map of the module.
3. **Meet your onboarding agent.** In Claude Code, ask:
   - `@onboarding-guide give me a tour of the payments module`
   - `@onboarding-guide walk me through the checkout flow step by step`
   - `@onboarding-guide what are the most important files I should read first?`

   (No Claude Code? Ask the same questions in **Copilot Chat** — with `copilot-instructions.md` in
   the repo it answers from the same module context.)

---

## First-week reading order

1. **Module Overview** — what the payments UI does and the tech stack. *(KB §1)*
2. **Component & Service Map** — the building blocks and where they live. *(KB §2)*
3. **Payment UI Flows** — follow one end-to-end flow (e.g. checkout → submit → confirmation). *(KB §3)*
4. **State & Data Flow + API Contracts** — how data moves and what the backend expects. *(KB §4–5)*
5. **Business & Validation Rules** — the money rules you must never break. *(KB §6)*
6. **Dependency & Impact Map** — how changing one thing affects others. *(KB §7)*
7. **Fragile / High-Risk Areas** + [`CODE_ANALYSIS.md`](CODE_ANALYSIS.md) — what to be careful with.

After each section, ask `@onboarding-guide` to explain anything unclear and to point you to the
exact file to open.

---

## Which agent to use when

| You want to… | Use | Example |
|---|---|---|
| Understand how something works | `@onboarding-guide` | "explain the refund flow" |
| Plan/implement a change safely | `@payment-dev` | "add a coupon field; what breaks?" |
| Get your code reviewed before a PR | `@code-reviewer` | "review my staged changes" |

---

## Ground rules for the payments module

- **Money is sacred:** never weaken validation, and respect currency/rounding/precision rules.
- **No double-submit:** payment actions must be guarded against being fired twice.
- **Clean up RxJS:** use the `async` pipe or `takeUntil(destroy$)` — no leaking subscriptions.
- **Performance:** `OnPush` change detection, `trackBy` on lists, no heavy work in templates.
- **Test critical flows:** add unit tests for any payment logic you touch.
- **Ask before guessing:** if the KB or an agent says something isn't documented, confirm with the team.

---

## Before your first PR

- [ ] I can run the module locally.
- [ ] I've read KB §1–3 and followed one payment flow end-to-end.
- [ ] I used `@payment-dev` to plan my change and saw the impact analysis.
- [ ] I ran `@code-reviewer` on my diff and addressed the findings.
- [ ] My change has tests and doesn't break a documented business rule.

Welcome aboard — when in doubt, ask an agent first, then your team. 🚀
