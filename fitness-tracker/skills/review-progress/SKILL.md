---
name: review-progress
description: Analyze training, bodyweight, and nutrition trends and give plan-aware suggestions from the Fitness Tracker. Use when the person asks how they're doing or what to do next — "how's my progress", "am I on track for my goal", "what should I train today", "show my bench over the last month", "is my weight moving", "how many calories have I averaged", "what's my volume this week". Do NOT use it to record new entries — that is the log-training skill.
---

Use this skill when the person is asking about their data or wants guidance, not logging.

## Ground in their own programming
1. Start with `whoami` (goal, active plan name, last weigh-in / workout), then `get_active_plan`. Suggestions must be grounded in *this* person's stored goal and plan, not generic advice.

## Pull the right data
2. For one movement, use `get_history` with the exercise name. For anything cross-table (volume by week, calories vs training days, PRs across measurement types), use `query` with read-only SQL. For bodyweight, use `get_weight_trend`.
3. The server returns raw rows and does **not** aggregate. Compute rolling averages, weekly volume, and rate-of-change yourself from those rows, and read rate against the person's stated goal (e.g. lbs/week vs a target date).

## Answer well
4. Show the trend and the number that supports it, not just a verdict. Prefer concrete comparisons ("bench top set 185→195 over four weeks") over vague encouragement.
5. If your suggestion departs from the active plan, say so explicitly and why — don't silently override their programming.

## Guardrails
- Don't fabricate data points; if the history is too thin to call a trend, say that instead.
- Sets are measured in reps, seconds (`duration_sec`), or metres (`distance_m`) — compare like with like (a hold's progression is time, not weight).
- This is not medical or clinical advice; keep it to training, nutrition logging, and progress.
