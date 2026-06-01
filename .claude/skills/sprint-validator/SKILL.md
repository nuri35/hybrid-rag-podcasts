---
name: sprint-validator
description: Validates a recently shipped backend sprint end-to-end by exercising real HTTP endpoints, inspecting server logs, and producing a structured report. Triggered when the user wants to confirm a sprint actually works in the running system.
---

# Sprint Validator Skill

You are validating a backend sprint that has already been implemented and committed.

## When to use

- After a sprint's implementation prompt has completed all steps
- When the user wants confidence that the code works end-to-end (not just unit tests)
- When verifying that a sprint's design decisions actually hold under live traffic

## Validation methodology

For every sprint, follow this four-stage process:

### Stage 1 — Inventory the scenarios

List every scenario the sprint was designed to handle. Pull these from:
- The sprint's ADR if it exists
- The CHANGELOG entry
- The commit messages
- Inline code comments

For each scenario, write down:
- What the input looks like (request shape, headers, repetition pattern)
- What the expected behavior is (HTTP status, response body, log lines)
- What "fail" looks like (specifically what would prove the implementation is wrong)

### Stage 2 — Prepare the environment

Before running any test:
- Confirm the dev server is running and healthy (curl `/health`, expect 200)
- Confirm Redis is reachable (`docker exec` ping)
- Confirm Chroma is reachable
- Clear any persistent state that could pollute the test (e.g., Redis keys from previous runs)

If any of these fail, stop and report. Do not attempt validation against a broken environment.

### Stage 3 — Execute scenarios

For each scenario:
1. Run the curl command (or sequence of commands) that exercises the scenario
2. Capture the HTTP response (status code, headers, body)
3. Capture the relevant server log lines that prove what happened internally
4. Compare actual vs expected
5. Record a verdict: PASS / FAIL / INCONCLUSIVE

Use `Measure-Command` or `time` to capture latency where relevant.

### Stage 4 — Produce the report

Write a structured markdown report. It must include:
- One section per scenario with verdict + evidence
- A summary table at the end
- Any anomalies observed during the run (warnings in logs, unexpected timings, etc.)
- An honest "limitations of this validation" section — what couldn't be tested manually and why

The report is the deliverable. Save it to `docs/sprint-validation/{sprint-name}-{date}.md`.

## Key principles

- **Evidence over assertion.** Never write "this works" without quoting the log line or response body that proves it.
- **Investigate anomalies.** If a log line looks weird (warning where there shouldn't be one, latency higher than expected), pause and dig in before moving on.
- **Honest about gaps.** If a scenario can't be manually triggered (e.g., real Gemini outage), say so. Don't pretend coverage you don't have.
- **Stop and ask if the environment is broken.** Don't run tests against a half-broken system and produce a misleading report.
