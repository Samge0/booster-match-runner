# Booster Match Runner

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Booster Internals (给 AI 看的上下文)](./docs/booster-internals.md)

A sidebar panel for **Booster Studio** that runs **3v3 robot soccer matches** between two agents (Red vs Blue), with live score, key-event timeline, headless runs, and automatic match-record archiving.

> The whole panel — every label, button and event name — can be switched between **English and Chinese** with one click. The language choice is remembered.

---

## ✨ Features

- **Pick two agents** from the running sim container and/or local `.agent` files (Red vs Blue).
- **Two run modes**
  - **Start Match + UI** — launches the simulator replay window and starts a visual match.
  - **Start Headless** — runs matches without the visualization UI.
- **Live score & match time** polled every 3 s; auto-detects match finish.
- **Key Events timeline** — goals, fouls, set-plays, etc. read incrementally from the container's `events.jsonl`.
- **Auto-save & export**
  - Every finished match is archived to `~/.booster-match-runner/matches/` (zip = summary + events + run log).
  - **Match records** picker: reveal a record in the file manager, or **export all to CSV** (Excel-friendly, UTF-8 BOM).
  - **Save log** — manually pack the current match into a zip.
- **Upload `.agent`** packages straight into the container. Uploading an agent whose ID already exists lets you deploy it under a **custom ID/name** as an independent copy (or overwrite) — the same agent can then play on both teams.
- **Manage agents** — the **Manage** action lists every agent; delete any one (container agents are removed from the container, local `.agent` files from disk) with a confirmation prompt.
- **Start the sim container** from the panel if it isn't running (with a spinner while it boots).
- **Optional auto-end** — set a max duration (s) and/or a lead-goal margin on the panel; `0` disables it, so the match ends only when the sim reports it finished.
- **Resilient** — survives a Booster Studio window reload/reopen: the Red/Blue pickers restore the two teams of the in-progress match and the **End** button stays clickable.

---

## 🔢 Version mapping

| Plugin version | Booster Studio | sim image (default) | Notes |
|---|---|---|---|
| 0.2.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | Duplicate-ID upload with custom id/name, agent manage/delete, reload-safe pickers |
| 0.1.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | i18n (EN/ZH), new icon, GitHub Actions release pipeline |

> The required Booster Studio version is also declared in `engines.boosterStudio` in `package.json`.

---

## ✅ Requirements

- **Booster Studio ≥ 1.9.10**.
- **Docker** reachable from the host CLI (`docker` on PATH).
- The **virtual-robot sim container** running (the extension can start it for you).
- Node.js 18+ only if you build from source.

---

## 🔧 First-time setup (required!)

The 3v3 match runtime this extension talks to — the game-control HTTP API on port **38383**, the `football3v3_runner`, and the `events.jsonl` log — is **not bundled in the image**. Booster Studio deploys it into the container **when you click the Run button**. So before the extension can start any match (and after every container rebuild), do this once:

1. In Booster Studio's left activity bar, open **ROBOTS** → pick **Virtual robot** to create/start the Docker container.
2. Click the **Run** button (top-right). Booster Studio deploys the full 3v3 match stack into the container.
3. Once `football3v3_runner` exists and port 38383 is listening, the extension is ready.

> ⚠️ **Rebuild = redeploy.** If that Docker container is deleted and recreated, these dependencies are gone — click **Run** once more to inject them again. Otherwise the extension hangs at `Health 1/15 … 15/15` and fails with `Runner not ready in 75s`.

---

## 📦 Installation

### Option A — From a Release (recommended)

1. Go to the project's **Releases** page and download the latest `booster-match-runner-<ver>.vsix`.
2. Install it into Booster Studio — either:
   - **GUI:** Command Palette → `Extensions: Install from VSIX...` → pick the file.
   - **CLI:**
     ```bash
     # Windows
     "<BoosterStudio>\bin\booster-studio.cmd" --install-extension booster-match-runner-<ver>.vsix --force
     # macOS / Linux
     booster-studio --install-extension booster-match-runner-<ver>.vsix --force
     ```
3. Reload the window. The **Match Runner** icon appears in the activity bar.

### Option B — Build from source

```bash
npm install
npm run compile
npx vsce package --no-git-tag-version --allow-missing-repository
# then install the produced .vsix as in Option A
```

> See [Custom builds](#-custom-builds--ci-releases) for fork-and-CI workflows.

---

## ⚙️ Configuration

Open Booster Studio Settings and search for `boosterMatch`:

| Setting | Default | Description |
|---|---|---|
| `boosterMatch.containerName` | `""` | Docker container name. If empty, auto-detected from `simImage`. |
| `boosterMatch.simImage` | `booster-robotics-registry.cn-beijing.cr.aliyuncs.com/virtual-robot/virtual-robot:0.6.5-beta` | Image used to locate/start the sim container. |
| `boosterMatch.gameControlPort` | `38383` | Game-control HTTP API port **inside** the container. |
| `boosterMatch.defaultOpponent` | `com.booster.default3v3ai` | Default Blue-team agent id. |
| `boosterMatch.projectsDir` | `""` | Host dir of Booster Studio agent projects (scanned for `.agent`). |
| `boosterMatch.hostAgentRoots` | `[]` | Extra host dirs to scan for `.agent` files. |

---

## 🕹️ Usage

1. Make sure the sim container is running (use **Start Container** if not).
2. Pick **Red** and **Blue** agents in the **Teams** section.
3. (Optional) Set the **Count** — multiple matches are played one-by-one in a queue.
4. Click **Start Match + UI** (visual) or **Start Headless** (no UI).
5. Watch the live score + Key Events; the match auto-saves when finished.
6. Use the 📋 button to open **Match records**, reveal a file, or export all to CSV.
7. Use **Manage** to delete any agent you no longer need (container or local `.agent` file).

---

## 🛠️ Custom builds & CI releases

This repo ships a GitHub Actions workflow (`.github/workflows/release.yml`) that:

- triggers on any **`v*` tag** (e.g. `v0.1.0`),
- builds the `.vsix` on Ubuntu + Node 20,
- attaches it to the **GitHub Release for that tag**, with auto-generated notes.

**Fork → customize → release** flow:

```bash
git clone https://github.com/Samge0/booster-match-runner
# ...edit, bump version in package.json...
git tag v0.1.0
git push origin v0.1.0
# GitHub Actions builds and publishes the .vsix to your fork's Releases
```

> The workflow needs **no secrets** — `permissions: contents: write` is enough for `softprops/action-gh-release`.

---

## 🤖 AI-first troubleshooting

This extension is complex (Docker, ROS2 env, in-container HTTP API). **When something breaks, ask an AI first** — paste the error plus the relevant context from [docs/booster-internals.md](./docs/booster-internals.md) (image, paths, API, runner command, design). That doc is specifically written to be fed to an AI so it can fix bugs or add features for you.

There's even a ready-made prompt at the bottom of that doc that lets a local AI **compile and install** the extension into Booster Studio for you.

---

## 🤝 Contributing

Issues and **Pull Requests are welcome**. For non-trivial changes, please describe the scenario you're fixing.

---

## ⚠️ Disclaimer

- This project is intended mainly for **learning and research** on Booster robot soccer development.
- The code was **co-written with AI assistance**; you should expect to iterate with an AI when you hit compatibility issues or bugs — that is the supported workflow, not a fallback.
- It is **not affiliated with or endorsed by Booster Robotics**. All trademarks belong to their owners.
- Use at your own risk; verify match results before relying on them for anything serious.

---

## 📄 License

MIT
