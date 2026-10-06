---
name: log-training
description: Record training, weigh-ins, and meals into the Fitness Tracker from natural language. Use whenever the person reports something they did — in the gym, on the mat, on the scale, or at the table — including indirect phrasing like "did legs today", "bench 3x8 at 185", "forgot to log Monday's pull day", "weighed in at 212 this morning", "3 sets of pull-ups 12/10/8", "held a 2-minute plank", "40-yard farmer's carry at 50s", "BJJ tonight, 90 minutes", or "ate 3 eggs and oats". Do NOT use it for analysis or advice — that is the review-progress skill.
---

Use this skill when the person is reporting what they did, not asking about it.

## Orient first
1. Call `whoami` once. Use its `today` and `server_timezone` to resolve relative dates ("Monday", "yesterday") to an explicit `YYYY-MM-DD` before any write. It also confirms whose log you are writing to.

## Resistance training → `log_sets`
2. Call `list_exercises` first and map the person's phrasing onto an existing name ("incline db" → "Incline Dumbbell Press"). Only introduce a new Title Case name when nothing matches.
3. One `log_sets` call carries the whole report. Expand shorthand into individual set rows: `4x8 @185` is four rows; explicit per-set reps ("185x8, 185x8, 190x6") are one row each.
4. Every set needs at least one of `reps`, `duration_sec`, or `distance_m`. A plank is `duration_sec`; a carry can be `distance_m` **and** `weight_lbs`. Convert any distance the person gives into **metres** ("40 yards" → `distance_m` 36.58). `weight_lbs` is null for bodyweight.
5. A session the person can't put numbers to ("did legs, don't remember the weights", "BJJ, 90 min") is `log_workout_meta`, not `log_sets`.

## Weigh-ins and meals
6. A weight goes to `log_weighin` (one row per day; logging the same day again just updates it).
7. Food goes to `log_meal`. If the person didn't give macros, estimate them and set `source: "estimate"`; when they dictate exact numbers, use them and `source: "manual"`.

## Close the loop
8. Confirm what landed by echoing the ids the write tools return, so a mistake is easy to correct with `update_set` / `delete_sets` / `update_meal`.

## Guardrails
- Don't invent reps, weights, or macros the person didn't give — estimate only for meals, and say when you're estimating.
- If a report is genuinely ambiguous (which day, which exercise), ask one short question rather than guessing.
- The tool descriptions carry the authoritative parsing detail; when they and this skill ever disagree, follow the tool description.
