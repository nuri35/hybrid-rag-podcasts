---
description: Run end-to-end validation for the most recently completed sprint and produce a structured report.
---

# /validate-sprint

Read the most recent sprint completion from CHANGELOG.md. Identify the scenarios it was designed to handle. Invoke the sprint-validator skill to walk through each scenario against the running system. Produce a markdown report at `docs/sprint-validation/{sprint-name}-{date}.md`.

If the user provides an explicit sprint name (e.g., `/validate-sprint sprint-rate-limit`), use that instead of the most recent one.

Stop and ask the user before running any sequence that costs real Gemini quota or that would meaningfully affect the dev environment beyond the test itself.
