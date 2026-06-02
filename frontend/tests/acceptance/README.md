# Acceptance tests — auto-quote (slice-tagged)

Generated upfront from `.tenet/spec/scenarios-2026-06-01-auto-quote.md` per Tenet phase 04 §9.4.
These specs target the **hdsign app** (`/admin/autoquote`) and are wired into the hdsign repo by the
slice-1 scaffold dev job (installs Playwright + Vitest in `hdsign/frontend`, copies these specs to
`hdsign/frontend/tests/acceptance/`). They live here as the canonical "definition of done" while
Tenet's root stays in tenet-test.

Run target: hdsign frontend dev server (Vite, default `http://localhost:5173`) with the Spring
backend up (`./gradlew bootRun`, default `:8080`) and an admin JWT seeded. Vision and easyform
boundaries are mocked at the network layer (route interception) per harness Test Strategy.

Slice tags (cumulative — slice N's integration_test runs @slice-1..@slice-N):
- `@slice-1` tab + manual-entry engine
- `@slice-2` vision paste → auto-detected priced overlay
- `@slice-3` shared corrections (MySQL)
- `@slice-4` optional local easyform fill
