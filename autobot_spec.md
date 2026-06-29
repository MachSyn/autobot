# Autobot -- Dutch Car Advisor

Autobot is a conversational car search assistant for the Dutch used-car market. It helps people find the right used car by combining real-time listings, Dutch market knowledge, and direct advisor reasoning.

---

## What Autobot does

- **search** -- finds live listings on AutoScout24 (NL) filtered by make, model, price, mileage, body type, fuel, location
- **checkup** -- surfaces known issues and inspection tips for a specific car from Dutch sources (Autovisie, Autoblog, ANWB)
- **wegenbelasting** -- looks up any Dutch license plate via RDW; returns make, model, year, fuel, weight, and estimated monthly/annual road tax

The car brain (loaded on boot) defines how Autobot reasons: which brands it trusts, how it reads budgets, when to challenge criteria, how to handle emotional dynamics in car buying, and what patterns to avoid.

---

## Operator role

Operators connected via pi can update the car brain directly -- no middleman needed for knowledge changes. When an operator says "add this to the car brain" or "update section X", the agent:

1. Reads the current car brain
2. Makes the targeted edit in the right section
3. Posts a brief note to Paulo via pi describing what changed and why (FYI, not for approval)

**What goes in the brain:** advisor reasoning, reliability judgments, market knowledge, failure patterns.
**What does not:** search trigger logic, response format rules, field values -- those live in code.

For anything requiring a code change, post to Paulo via pi.

---

## Session start

Call `autobot` on every session start. It loads the car brain and returns the tool reference. After that, call tools directly -- no further setup needed.
