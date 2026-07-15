# Changelog

## 0.1.0

First public release.

- **Run 3v3 robot soccer matches** between any two agents (Red vs Blue), picked from the running sim container and/or local `.agent` files.
- **Two modes**: visual match (opens the simulator replay UI) and headless (no UI); queue several matches in a row via **Count**.
- **Live score & match clock**, polled every 3 s, with automatic finish detection.
- **Key Events timeline** — goals, fouls, set-plays and more, streamed from the container's `events.jsonl`.
- **Configurable auto-end** — set a match length (s) and/or a lead-goal margin on the panel; `0` leaves the end to the sim.
- **Match records** — every finished match is archived (summary + events + run log); export all to CSV (Excel-friendly); manually save a match-log zip anytime.
- **One-click sim-container start** and **`.agent` upload** straight into the container.
- **English / Chinese** one-click language toggle for the whole panel.
