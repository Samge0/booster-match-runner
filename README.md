# Booster Match Runner

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Booster Internals (给 AI 看的上下文)](./docs/booster-internals.md)

A sidebar panel for **Booster Studio** that runs **3v3 robot soccer matches** between two agents (Red vs Blue), with live score, key-event timeline, headless runs, and automatic match-record archiving.

> The whole panel — every label, button and event name — can be switched between **English and Chinese** with one click. The language choice is remembered.

<img width="443" height="280" alt="image" src="https://github.com/user-attachments/assets/09916441-fae8-4597-aec7-6417ff50ddb0" />

<img width="423" height="360" alt="image" src="https://github.com/user-attachments/assets/b4cc2a9d-15b2-4c15-b8e6-2c4bb4c6a1ae" />

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
- **Video recording (UI mode)** — enable `boosterMatch.recordVideo` to capture each visual match as an MP4 of the Booster Studio window (the viewer, score and robot skins exactly as shown); saved next to the match record, with both team names in the filename. Needs `ffmpeg` on the host; the window must stay foreground.
- **Upload `.agent`** packages straight into the container. Uploading an agent whose ID already exists lets you deploy it under a **custom ID/name** as an independent copy (or overwrite) — the same agent can then play on both teams.
- **Manage agents** — the **Manage** action lists every agent; delete any one (container agents are removed from the container, local `.agent` files from disk) with a confirmation prompt.
- **Start the sim container** from the panel if it isn't running (with a spinner while it boots).
- **Optional auto-end** — set a max duration (s) and/or a lead-goal margin on the panel; `0` disables it, so the match ends only when the sim reports it finished.
- **Resilient** — survives a Booster Studio window reload/reopen: the Red/Blue pickers restore the two teams of the in-progress match and the **End** button stays clickable.
- **Diagnostics & forensics** — a **Diagnose** button lists running `ros2 launch` processes and stale sandboxes; if a match start fails, the failure scene (`run.py` log tail, `/health`, live processes) is auto-saved to `~/.booster-match-runner/match-start-failure.log`. Deleting an agent that's currently playing in a running match is blocked.

---

## 🔢 Version mapping

| Plugin version | Booster Studio | sim image (default) | Notes |
|---|---|---|---|
| 0.2.5 | **1.9.10** | auto-detected (any tag) | Match video recording (UI mode, cross-platform window capture to MP4); record/zip filenames include both teams |
| 0.2.4 | **1.9.10** | auto-detected (any tag) | Fix: robots don't move after End→Start — leftover team `ros2 launch` parents now killed at End and before each match |
| 0.2.3 | **1.9.10** | auto-detected (any tag) | Count works in visual mode, auto-end no longer kills the batch, retried start/end, marketplace install |
| 0.2.2 | **1.9.10** | auto-detected (any tag) | Bot-freeze forensics logging + Diagnose button, mid-match delete guard, restart-Studio error hints |
| 0.2.1 | **1.9.10** | auto-detected (any tag) | Reload-safe auto-end, tag-agnostic container detection, headless button-state fixes, settings-first config |
| 0.2.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | Duplicate-ID upload with custom id/name, agent manage/delete, reload-safe pickers |
| 0.1.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | i18n (EN/ZH), new icon, GitHub Actions release pipeline |

> The required Booster Studio version is also declared in `engines.boosterStudio` in `package.json`.

---

## ✅ Requirements

- **Booster Studio ≥ 1.9.10**.
- **Docker** reachable from the host CLI (`docker` on PATH).
- The **virtual-robot sim container** running (the extension can start it for you).
- **`ffmpeg` on the host PATH** — only needed for match video recording (UI mode); otherwise optional.
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

### Option A — From the extension marketplace (recommended)

Open the **Extensions** view in Booster Studio (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **Booster Match Runner**, and click **Install**.

### Option B — From a Release (.vsix)

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

### Option C — Build from source

```bash
npm install
npm run compile
npx vsce package --no-git-tag-version --allow-missing-repository
# then install the produced .vsix as in Option B
```

> See [Custom builds](#-custom-builds--ci-releases) for fork-and-CI workflows.

---

## ⚙️ Configuration

Open Booster Studio Settings and search for `boosterMatch`:

| Setting | Default | Description |
|---|---|---|
| `boosterMatch.containerName` | `""` | Docker container name. If empty, auto-detected from `simImage`. |
| `boosterMatch.simImage` | `""` | Optional image name (substring match) to auto-detect the sim container. Empty falls back to `virtual-robot/virtual-robot` (any version); set full image:tag to pin a version. |
| `boosterMatch.gameControlPort` | `38383` | Game-control HTTP API port **inside** the container. |
| `boosterMatch.defaultOpponent` | `com.booster.default3v3ai` | Default Blue-team agent id. |
| `boosterMatch.matchLength` | `0` | Auto-end each match after this many seconds. `0` = disabled (run until the sim finishes or you click End). |
| `boosterMatch.leadGoals` | `0` | Auto-end once one team leads by this many goals (either side). `0` = disabled. |
| `boosterMatch.hostAgentRoots` | `[]` | Host dirs to scan for `.agent` files (one level into each root + root-level `.agent`). |
| `boosterMatch.recordVideo` | `false` | Record each UI-mode match by capturing the Booster Studio window to an MP4 (next to the match zip). Needs `ffmpeg` on the host; the window must stay foreground. |

### Configuring recording dependencies (Windows / Ubuntu / macOS)

Match video recording captures the Booster Studio window via the host's `ffmpeg`, plus a small OS-specific window-listing helper. Install once:

- **Windows** — `ffmpeg` only:
  - `winget install Gyan.FFmpeg`, or download from <https://www.gyan.dev/ffmpeg/builds/>, unzip and add `bin` to PATH.
- **Ubuntu / Debian** — `ffmpeg` + window tools:
  - `sudo apt install ffmpeg wmctrl x11-utils`
  - Recording uses X11 (`x11grab`); on a Wayland-only session, run Booster Studio under **XWayland**.
- **macOS** — `ffmpeg`:
  - `brew install ffmpeg`
  - The first recording triggers a macOS prompt to grant Booster Studio **Accessibility** permission (System Settings → Privacy & Security → Accessibility); allow it and retry. The screen device index is assumed to be `1`; if you get the wrong/black screen, list devices with `ffmpeg -f avfoundation -list_devices true -i ""` (that index is hardcoded for now).

Verify `ffmpeg` with `ffmpeg -version`. When you tick **Record video**, the panel checks for `ffmpeg` first; if it isn't found you get a prompt to install/configure it before recording.

> All platforms capture the visible screen, so keep the Booster Studio window foreground & unobstructed while recording (a minimized/covered window records blank).

### Verified recording setups

The capture pipeline (ffmpeg window capture + the OS-specific window locator) is **verified working** on the setups below. On other systems it may need extra steps — see the **AI-first troubleshooting** section below.

| OS | Desktop / display | Key dependencies | Notes |
|---|---|---|---|
| **Windows 10 / 11** | — | `ffmpeg` | Only `ffmpeg` on PATH is needed (uses `gdigrab`). |
| **Ubuntu 24.04 LTS** | GNOME on **X11**, gdm (`DISPLAY=:1`) | `ffmpeg`, `wmctrl`, `x11-utils` | `sudo apt install ffmpeg wmctrl x11-utils`. Verified at 2560×1080; the Booster Studio window title contains "Booster Studio", which the locator greps for. The X display number is read from `$DISPLAY` at runtime — gdm sessions are commonly `:1`, **not** `:0`. |

> The author's hardware is limited. If recording fails on your system (Wayland-native sessions, other distros, multi-monitor, remote/headless), paste the ffmpeg error to an AI along with [docs/booster-internals.md](./docs/booster-internals.md) — that is the supported path, not a fallback.

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

## 💬 Community

This panel runs on top of **Booster Studio** — the embodied-development IDE from **Booster Robotics (加速进化)**. Booster Robotics builds a developer platform for humanoid robots (T1 / K1) and open-sources the soccer stack this plugin drives. Join the Booster developer community for the latest news, robot open-source resources, and technical discussion:

| Feishu | Discord | Official site |
|:---:|:---:|:---:|
| <img src="https://github.com/user-attachments/assets/41885d6f-fca4-4acc-bab4-6a12fe5bbd55" alt="Booster Studio Dev Community" width="128"> | <img src="https://github.com/user-attachments/assets/c2c24437-9cda-4bc8-a72e-100031e77fca" alt="Discord" width="128"> | <img src="https://github.com/user-attachments/assets/2a1e1f21-95b7-4dae-a20e-019fbe46274a" alt="booster.tech" width="128"> |
| [Booster Studio Dev Community](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=cd0g4e4b-661a-4ab3-8555-f4be56b173ae) | [Booster Discord](https://discord.gg/dCJARfRfe) | [booster.tech](https://www.booster.tech/) |

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
