/**
 * Match Runner sidebar panel.
 * Fixes: (1) container start button, (2) match-in-progress check,
 * (3) rclpy/ROS2 env injection for 3v3 runner.
 */

import * as vscode from "vscode";
import { getAllAgents, readAgentFileMeta, containerAgentExists } from "./agentManager";
import { getMatchStatus, startMatch as apiStartMatch, endMatch as apiEndMatch } from "./matchRunner";
import { isContainerRunning, dockerExec, cloneAgent, deployAgentFile, gameControlApi, dockerExecDetached, startSimContainer } from "./docker";
import { AgentInfo, MatchStatus } from "./types";
import { getBaseLineCount, readNewEvents, dedupeByEventId, ParsedEvent, shellQuote } from "./eventReader";
import { initLang, toggleLang, getI18nBundle, t, eventLabel, getLang } from "./i18n";
import AdmZip from "adm-zip";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as cp from "child_process";
import { WindowRecorder } from "./windowRecorder";

/** Path to game-control events.jsonl inside the container (fixed, not user-configurable). */
const EVENTS_LOG_PATH = "/usr/local/booster_robot/booster_robocup_sim/logs/game-control/events.jsonl";

interface TeamSelection { red: string; blue: string; }

const MODE_VISUAL = "visual";
const MODE_HEADLESS = "headless";
type MatchMode = typeof MODE_HEADLESS | typeof MODE_VISUAL;

interface MatchRecord {
    zipPath: string;
    savedAt: string;
    mode: MatchMode;
    red: { id: string; name: string };
    blue: { id: string; name: string };
    redScore: number;
    blueScore: number;
    startedAtWallTime: number | null;
    endedAtWallTime: number | null;
}

/** Format an epoch-ms or ISO string as Shanghai time (UTC+8): YYYY-MM-DD HH:mm:ss */
function fmtShanghai(value: number | string): string {
    const d = typeof value === "number" ? new Date(value) : new Date(value);
    return d.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
}

export class MatchRunnerProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private agents: AgentInfo[] = [];
    private selection: TeamSelection = { red: "", blue: "" };
    private isRunning = false;
    private currentEvents: ParsedEvent[] = [];
    private baseLineCount = 0;
    private eventsLogPath = EVENTS_LOG_PATH;
    private lastStatus: MatchStatus | null = null;
    private finishEventAdded = false;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private matchStartedAt: number | null = null;
    private currentMode: MatchMode = MODE_HEADLESS;
    private autoEnded = false;
    private startingNew = false;
    private output: vscode.OutputChannel;
    private windowRecorder: WindowRecorder | null = null;
    private windowMp4Path: string | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel("Booster Match Runner");
        initLang(context);
    }

    async resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = this.getHtml();
        this.postI18n();
        view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
        view.onDidDispose(() => this.stopPolling());
        await this.refresh();
        // If a match is already in progress (e.g. after reload/reopen) and no
        // monitorMatch is driving it, recover the event baseline so the Key Events
        // list resumes from the CURRENT match.
        try {
            const status = await getMatchStatus();
            const active = status.state === "playing" || status.state === "ready" || status.state === "set";
            if (active && !this.isRunning) {
                this.isRunning = true;
                const cur = this.loadCurrentTeams();
                if (cur) { this.currentMode = cur.mode; }
                this.postMessage({ type: "matchActive", mode: this.currentMode });
                await this.recoverEventTracking();
            }
        } catch { /* status unreachable */ }
        if (this.currentEvents.length) { this.postEventsToView(); }
        this.startPolling();
    }

    async refresh() {
        this.postMessage({ type: "loading" });
        const running = await isContainerRunning();
        if (!running) {
            this.agents = [];
            this.postMessage({ type: "agents", agents: [], selection: this.selection, containerRunning: false });
            return;
        }
        this.agents = await getAllAgents();
        // After a reload the selection is empty; restore the two teams from the
        // last started match (persisted locally) instead of defaulting to the
        // first agent.
        if (!this.selection.red && !this.selection.blue) {
            const cur = this.loadCurrentTeams();
            if (cur) {
                this.output.appendLine(`[MatchRunner] reload team recovery: saved=${cur.red} vs ${cur.blue}`);
                if (this.agents.some((a) => a.id === cur.red)) { this.selection.red = cur.red; }
                if (this.agents.some((a) => a.id === cur.blue)) { this.selection.blue = cur.blue; }
            }
        }
        const config = vscode.workspace.getConfiguration("boosterMatch");
        const defaultOpponent = config.get<string>("defaultOpponent", "com.booster.default3v3ai");
        if (!this.selection.red) {
            this.selection.red = this.agents[0]?.id || "";
        }
        if (!this.selection.blue) {
            const blue = this.agents.find((a) => a.id === defaultOpponent) || this.agents[1];
            this.selection.blue = blue?.id || "";
        }
        this.postMessage({ type: "agents", agents: this.agents, selection: this.selection, containerRunning: true });
        this.updateStatus();
    }

    async updateStatus() {
        try {
            const status = await getMatchStatus();
            this.postMessage({ type: "status", status, teams: this.currentTeamsInfo() });
        } catch {
            this.postMessage({ type: "status", status: null });
        }
    }

    /** Persist the two teams of the currently running match to disk so a reload
     *  can restore the picker. Stored under ~/.booster-match-runner/. */
    private saveCurrentTeams(red: string, blue: string): void {
        try {
            const dir = path.join(os.homedir(), ".booster-match-runner");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "current-teams.json"), JSON.stringify({ red, blue, mode: this.currentMode, savedAt: Date.now() }, null, 2), "utf8");
        } catch { /* best effort */ }
    }

    private loadCurrentTeams(): { red: string; blue: string; mode: MatchMode } | null {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".booster-match-runner", "current-teams.json"), "utf8"));
            if (d && d.red && d.blue) {
                return { red: String(d.red), blue: String(d.blue), mode: d.mode === MODE_VISUAL ? MODE_VISUAL : MODE_HEADLESS };
            }
        } catch { /* not present yet */ }
        return null;
    }

    /** Resolve the current match's team display names from current-teams.json
     *  (ids mapped to names via the agent list). Shipped to the webview so
     *  winner/kickingSide show the names of the teams actually in THAT match,
     *  decoupled from the team dropdown — which the user may re-point after the
     *  match ended. Falls back to the raw id when the agent name is unknown. */
    private currentTeamsInfo(): { red: { id: string; name: string }; blue: { id: string; name: string } } {
        const t = this.loadCurrentTeams();
        const resolve = (id: string): { id: string; name: string } => {
            const found = this.agents.find((a) => a.id === id);
            return { id, name: found ? found.name : id };
        };
        if (!t) {
            return { red: { id: "", name: "" }, blue: { id: "", name: "" } };
        }
        return { red: resolve(t.red), blue: resolve(t.blue) };
    }

    private async handleMessage(msg: any) {
        switch (msg.type) {
            case "toggleLang": {
                toggleLang();
                this.postI18n();
                this.updateStatus();
                if (this.currentEvents.length) { this.postEventsToView(); }
                break;
            }
            case "refresh": await this.refresh(); break;
            case "selectRed": this.selection.red = msg.agentId; break;
            case "selectBlue": this.selection.blue = msg.agentId; break;
            case "startVisual": await this.startVisualMatch(msg.count || 1); break;
            case "startMatch": await this.startMatch(msg.count || 1); break;
            case "endMatch": await this.endMatch(); break;
            case "openSim": await this.openSimulator(); break;
            case "uploadAgent": await this.uploadAgentFile(); break;
            case "startContainer": await this.startContainer(); break;
            case "manageAgents": await this.manageAgents(); break;
            case "diagnose": await this.diagnoseEnvironment(); break;
            case "saveLog": await this.saveLog(); break;
            case "toggleRecord": {
                const cfg = vscode.workspace.getConfiguration("boosterMatch");
                const cur = cfg.get<boolean>("recordVideo", false);
                // Turning ON — require a working ffmpeg first; otherwise warn and stay off.
                if (!cur && !(await this.detectFfmpeg())) {
                    vscode.window.showWarningMessage(
                        t("recordNoFfmpeg"),
                        t("openReadme"),
                    ).then((act) => {
                        if (act === "Open README") {
                            vscode.commands.executeCommand(
                                "markdown.showPreview",
                                vscode.Uri.file(this.context.asAbsolutePath("README.md")),
                            );
                        }
                    });
                    this.postMessage({ type: "recordVideoState", value: false });
                    break;
                }
                await cfg.update("recordVideo", !cur, vscode.ConfigurationTarget.Global);
                this.postMessage({ type: "recordVideoState", value: !cur });
                break;
            }
            case "showRecords": await this.showRecords(); break;
            case "openSettings": await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:samge.booster-match-runner"); break;
        }
    }

    /** Start the Docker sim container if not running. */
    async startContainer() {
        this.output.show();
        this.output.appendLine("[MatchRunner] Starting container...");
        this.postMessage({ type: "containerStarting", starting: true });
        try {
            const name = await startSimContainer();
            if (!name) {
                vscode.window.showErrorMessage("Could not find sim container by image. Set boosterMatch.containerName in Settings.");
                return;
            }
            this.output.appendLine("[MatchRunner] Container started. Waiting 15s for init...");
            await new Promise(r => setTimeout(r, 15000));
            await this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage("Failed to start: " + err.message);
        } finally {
            this.postMessage({ type: "containerStarting", starting: false });
        }
    }

    /** Delete a single agent from the picker. Container agents are removed from
     *  the extract dir; local .agent files are deleted from disk. Confirms first
     *  since both are irreversible. */
    async deleteAgent(agentId: string) {
        const agent = this.agents.find((a) => a.id === agentId);
        if (!agent) { return; }
        // Block deleting an agent that is currently in a running match — run.py
        // still references it, and removing it mid-match can stall that team.
        // The user must stop the match first.
        if (this.isRunning && (this.selection.red === agentId || this.selection.blue === agentId)) {
            vscode.window.showWarningMessage(t("deleteBlockedByMatch"));
            return;
        }
        const where = agent.source === "container" ? `container:${agent.path}` : agent.path;
        const choice = await vscode.window.showWarningMessage(
            `${t("confirmDelete")}\n${where}`,
            "Delete", "Cancel"
        );
        if (choice !== "Delete") { return; }
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t("deletingAgent"), cancellable: false },
                async () => {
                    if (agent.source === "container") {
                        await dockerExec(`rm -rf "${agent.path}"`, 10000);
                    } else if (agent.path) {
                        await fs.promises.rm(agent.path, { recursive: true, force: true });
                    }
                    if (this.selection.red === agentId) { this.selection.red = ""; }
                    if (this.selection.blue === agentId) { this.selection.blue = ""; }
                    await this.refresh();
                },
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`${t("deleteFailed")}: ${err.message}`);
        }
    }

    /** Open a quick-pick of all agents (like the match-records picker); selecting
     *  one prompts deletion. Keeps the panel compact — the list is not shown by
     *  default. */
    async manageAgents() {
        if (!this.agents.length) {
            vscode.window.showInformationMessage(t("noAgents"));
            return;
        }
        const items = this.agents.map((a) => ({
            label: a.version ? `${a.name} v${a.version}` : a.name,
            description: `(${a.source} · ${a.id})`,
            detail: a.id,
            agentId: a.id,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: t("manageAgentsHint"),
        });
        if (!pick) { return; }
        await this.deleteAgent(pick.agentId);
    }

    /** Read-only environment diagnosis: dump running ros2 launch processes and
     *  accumulated historical sandboxes to the output channel so the user can
     *  inspect the container state when a match won't start cleanly. */
    private async diagnoseEnvironment(): Promise<void> {
        this.output.show(true);
        this.output.appendLine(t("diagTitle"));
        try {
            const out = await dockerExec("pgrep -af 'ros2 launch' 2>/dev/null | grep -v pgrep", 5000);
            const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
            this.output.appendLine(`[${t("diagRos2")}] ${lines.length}`);
            for (const l of lines) { this.output.appendLine("  • " + l); }
        } catch { this.output.appendLine(`[${t("diagRos2")}] <unavailable>`); }
        try {
            const out = await dockerExec("ls /run/3v3_runner/ 2>/dev/null", 5000);
            const all = out.split("\n").map((s) => s.trim()).filter(Boolean);
            const stale = all.filter((s) => s !== "team_1" && s !== "team_2");
            this.output.appendLine(`[${t("diagSandboxes")}] ${stale.length}` + (all.length !== stale.length ? ` (total ${all.length}, team_1/team_2 excluded)` : ""));
            for (const s of stale.slice(0, 30)) { this.output.appendLine("  • " + s); }
            if (stale.length > 30) { this.output.appendLine(`  ... and ${stale.length - 30} more`); }
        } catch { this.output.appendLine(`[${t("diagSandboxes")}] <unavailable>`); }
        this.output.appendLine("=".repeat(28));
    }

    /** Check no match is in progress. */
    private async checkNotRunning(): Promise<boolean> {
        if (this.isRunning) {
            const choice = await vscode.window.showWarningMessage(
                "A match is already running. Stop it and start a new one?",
                "Stop & Start New", "Cancel"
            );
            if (choice !== "Stop & Start New") { return false; }
            await this.endMatch();
            return true;
        }
        try {
            const status = await getMatchStatus();
            if (status && status.state === "playing" && status.durationSeconds > 5) {
                const choice = await vscode.window.showWarningMessage(
                    `Match in progress (${status.score.home}-${status.score.away}, ${Math.round(status.durationSeconds)}s). Start new?`,
                    "Start New", "Cancel"
                );
                if (choice !== "Start New") { return false; }
            }
        } catch { /* ignore */ }
        return true;
    }

    async openSimulator() {
        // Opening the simulator UI invokes booster.agent.run, which resets
        // game-control and interrupts a running headless match. Block it while
        // a headless match is in progress; visual mode owns its own UI window.
        if (this.isRunning && this.currentMode === MODE_HEADLESS) {
            vscode.window.showWarningMessage(t("simBlockedHeadless"));
            return;
        }
        for (const cmd of ["booster.virtualRobot.openSimulatorInAuxiliaryWindow", "booster.agent.run"]) {
            try { await vscode.commands.executeCommand(cmd); return; }
            catch { /* try next */ }
        }
        vscode.window.showInformationMessage("Click the robot icon in Booster Studio sidebar, then Run.");
    }

    async startVisualMatch(count = 1) {
        this.currentMode = MODE_VISUAL;
        if (!(await this.checkNotRunning())) { return; }
        if (!this.selection.red || !this.selection.blue) {
            vscode.window.showWarningMessage("Select agents for both teams."); return;
        }
        this.isRunning = true;
        this.startingNew = true;
        this.postMessage({ type: "matchStarting", mode: this.currentMode });
        this.output.show();
        // Kill any leftover team-agent processes from a previous run BEFORE
        // starting fresh. Especially needed after a window reload: reload
        // restarts the extension, breaking the in-process batch loop, so the
        // last match's team agents were never killed and keep holding their
        // ROS2 node/package names. Idempotent; preserves booster_agent_manager
        // and com_boosterobotics_default.
        this.output.appendLine("[MatchRunner] Cleaning up leftover team agents...");
        await this.killTeamAgentLaunches();
        try {
            // Open the simulator UI once for the whole batch.
            this.postMessage({ type: "status_text", text: "Opening UI view (~60s)..." });
            try { await vscode.commands.executeCommand("booster.agent.run"); }
            catch (e: any) { this.output.appendLine("booster.agent.run: " + e.message); }
            const { team1Id, team2Id } = await this.deployAndClone();
            if (!this.isRunning) { return; }
            const redName = this.agents.find((a) => a.id === this.selection.red)?.name || this.selection.red;
            const blueName = this.agents.find((a) => a.id === this.selection.blue)?.name || this.selection.blue;
            this.output.appendLine(`\n=== VISUAL x${count}: ${redName} vs ${blueName} ===\n`);
            for (let i = 0; i < count; i++) {
                if (!this.isRunning) { break; }
                this.postMessage({ type: "batchProgress", current: i + 1, total: count });
                this.output.appendLine(`\n--- Match ${i + 1}/${count} ---`);
                await this.resetEventTracking();
                this.postMessage({ type: "status_text", text: "Starting runner..." });
                await this.restartRunnerWithTeams(team1Id, team2Id);
                await this.startWindowRecordingIfEnabled();
                this.postMessage({ type: "status_text", text: "Starting match!" });
                await apiStartMatch();
                this.startingNew = false;
                this.postMessage({ type: "matchStarted", redName, blueName, mode: this.currentMode });
                await this.monitorMatch();
                await this.stopWindowRecording();
                await this.autoSaveRecord(MODE_VISUAL);
                if (!this.isRunning) { break; }
                if (i < count - 1) {
                    this.output.appendLine("  Ending match and cleaning up before next...");
                    try { await apiEndMatch(); } catch { /* already ended */ }
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
        } catch (err: any) {
            this.output.appendLine("ERROR: " + err.message);
            vscode.window.showErrorMessage("Match failed: " + err.message);
        } finally {
            await this.stopWindowRecording();
            this.isRunning = false;
            this.startingNew = false;
            this.postMessage({ type: "matchEnded" });
            // Batch finished (or aborted): clean up the FINAL match's team-agent
            // processes so they don't leak into the next batch / next End→Start.
            // restartRunnerWithTeams already cleans BETWEEN matches; this catches
            // the last one. Idempotent — harmless if endMatch already killed them.
            try { await apiEndMatch(); } catch { /* already ended */ }
            await this.killTeamAgentLaunches();
        }
    }

    async startMatch(count = 1) {
        this.currentMode = MODE_HEADLESS;
        if (!(await this.checkNotRunning())) { return; }
        if (!this.selection.red || !this.selection.blue) {
            vscode.window.showWarningMessage("Select agents for both teams."); return;
        }
        this.isRunning = true;
        this.startingNew = true;
        this.postMessage({ type: "matchStarting", mode: this.currentMode });
        this.output.show();
        // Kill any leftover team-agent processes from a previous run BEFORE
        // starting fresh. Especially needed after a window reload: reload
        // restarts the extension, breaking the in-process batch loop, so the
        // last match's team agents were never killed and keep holding their
        // ROS2 node/package names. Idempotent; preserves booster_agent_manager
        // and com_boosterobotics_default.
        this.output.appendLine("[MatchRunner] Cleaning up leftover team agents...");
        await this.killTeamAgentLaunches();
        try {
            const { team1Id, team2Id } = await this.deployAndClone();
            if (!this.isRunning) { return; }
            this.output.appendLine(`\n=== HEADLESS x${count}: ${team1Id} vs ${team2Id} ===\n`);
            for (let i = 0; i < count; i++) {
                if (!this.isRunning) { break; }
                this.postMessage({ type: "batchProgress", current: i + 1, total: count });
                this.output.appendLine(`\n--- Match ${i + 1}/${count} ---`);
                await this.resetEventTracking();
                await this.restartRunnerWithTeams(team1Id, team2Id);
                await apiStartMatch();
                this.startingNew = false;
                this.postMessage({ type: "matchStarted", redName: team1Id, blueName: team2Id, mode: this.currentMode });
                await this.monitorMatch();
                await this.autoSaveRecord(MODE_HEADLESS);
                if (!this.isRunning) { break; }
                if (i < count - 1) {
                    this.output.appendLine("  Ending match and cleaning up before next...");
                    try { await apiEndMatch(); } catch { /* already ended */ }
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
        } catch (err: any) {
            this.output.appendLine("ERROR: " + err.message);
            vscode.window.showErrorMessage("Match failed: " + err.message);
        } finally {
            this.isRunning = false;
            this.startingNew = false;
            this.postMessage({ type: "matchEnded" });
            // Batch finished (or aborted): clean up the FINAL match's team-agent
            // processes so they don't leak into the next batch / next End→Start.
            // restartRunnerWithTeams already cleans BETWEEN matches; this catches
            // the last one. Idempotent — harmless if endMatch already killed them.
            try { await apiEndMatch(); } catch { /* already ended */ }
            await this.killTeamAgentLaunches();
        }
    }

    private async monitorMatch() {
        const startTime = Date.now();
        let lastScore = "";
        // Count consecutive polls where the match is not actually playing.
        // If the match is interrupted externally (e.g. opening the simulator UI
        // during a headless match resets game-control back to "initial"), the
        // state gets stuck and isFinished never becomes true — without this
        // guard the loop would spin forever and the panel could not be ended.
        let staleCount = 0;
        while (this.isRunning) {
            const elapsed = (Date.now() - startTime) / 1000;
            let status: MatchStatus;
            try { status = await getMatchStatus(); }
            catch { await new Promise(r => setTimeout(r, 3000)); continue; }
            this.lastStatus = status;
            const sk = `${status.score.home}-${status.score.away}`;
            if (sk !== lastScore || status.isFinished) {
                this.output.appendLine(`[${elapsed.toFixed(0)}s] ${sk} | ${status.state} | ${status.durationSeconds.toFixed(0)}s`);
                lastScore = sk;
            }
            // NOTE: status + events UI updates AND the leadGoals/matchLength
            // auto-end are handled by pollOnce() (independent timer started in
            // resolveWebviewView), so they survive reload/reopen. monitorMatch
            // only logs and waits for the finish here.
            if (status.isFinished) {
                this.output.appendLine(`\n=== FINISHED: ${sk} ===\n`);
                break;
            }
            // "initial" only appears before kickoff or after a hard reset; a match
            // in play never returns to it. Stuck there for ~15s => interrupted.
            if (status.state === "initial") {
                if (++staleCount >= 5) {
                    this.output.appendLine(`\n=== INTERRUPTED: match disappeared (state=initial) ===\n`);
                    break;
                }
            } else { staleCount = 0; }
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    async endMatch() {
        // Force-unlock the panel first so the UI recovers even if the API call
        // no-ops (e.g. match already reset/disappeared). This also stops any
        // running monitorMatch loop and batch via the isRunning flag.
        this.isRunning = false;
        this.postMessage({ type: "matchEnded" });
        try { await apiEndMatch(); }
        catch { /* ignore */ }
        // /match/end only stops game-control scoring — it does NOT destroy the
        // team sandboxes, so the team-agent `ros2 launch` processes keep running
        // as dirty state that blocks the next match's agents from binding their
        // ROS2 node/package names (robots then don't move). Kill them so End
        // leaves the container clean (just agent_manager + default).
        await this.killTeamAgentLaunches();
    }

    async uploadAgentFile() {
        const ws = vscode.workspace.workspaceFolders;
        const roots = vscode.workspace.getConfiguration("boosterMatch").get<string[]>("hostAgentRoots", []);
        const defaultPath = (ws && ws.length > 0 ? ws[0].uri.fsPath : "") || (roots.length > 0 ? roots[0] : "");
        const uri = await vscode.window.showOpenDialog({
            canSelectMany: false, filters: { "Agent Package": ["agent"] },
            title: "Select .agent file",
            defaultUri: defaultPath ? vscode.Uri.file(defaultPath) : undefined,
        });
        if (!uri || uri.length === 0) { return; }
        const filePath = uri[0].fsPath;
        try {
            // On id collision, ask the user whether to deploy under a custom
            // id/name or overwrite the existing one. No collision (or choosing
            // overwrite / leaving the original id) falls through to the default
            // overwrite behavior.
            const meta = readAgentFileMeta(filePath);
            let idOverride: string | undefined;
            let nameOverride: string | undefined;
            if (await containerAgentExists(meta.id)) {
                // Id collision: open a single webview form (id + name together)
                // with version-suffix defaults, instead of two sequential input
                // boxes. Clearing/keeping the id means overwrite the original.
                const r = await this.promptCustomDeploy(meta);
                if (r === undefined) { return; }   // user cancelled
                if (r.idOverride) {
                    idOverride = r.idOverride;
                    nameOverride = r.nameOverride;
                    if (await containerAgentExists(r.idOverride)) {
                        const ow = await vscode.window.showWarningMessage(
                            t("customDeployAlsoExists").replace("{id}", r.idOverride),
                            t("customDeployOverwrite"),
                            t("customDeployCancel"),
                        );
                        if (ow !== t("customDeployOverwrite")) { return; }
                    }
                } else {
                    nameOverride = r.nameOverride;
                }
            }
            // Mode reflects reality: does the TARGET id (custom or original)
            // already exist in the container? exists => overwrite, else => new.
            // (idOverride being set just means "user typed a custom id in the
            // collision form", NOT "this is a new deploy" — a first-time upload
            // with no collision has idOverride undefined but is still a NEW deploy.)
            const targetId = idOverride || meta.id;
            const deployMode = (await containerAgentExists(targetId)) ? t("deployModeOverwrite") : t("deployModeNew");
            const id = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `${t("deployingAgent")} (${deployMode})`, cancellable: false },
                () => deployAgentFile(filePath, idOverride, nameOverride, (s) => this.diagLine(s)),
            );
            vscode.window.showInformationMessage(`${t("deployedAgent")}: ${id}`);
            await this.refresh();
        } catch (err: any) { vscode.window.showErrorMessage("Deploy failed: " + err.message); }
    }

    /** Open a webview form with two fields (agent id + display name) pre-filled
     *  with a version-suffix default, so the user can confirm both in one shot
     *  on id collision. VSCode has no native two-input-box API, hence webview.
     *  Resolves undefined on cancel; otherwise {idOverride?, nameOverride?}.
     *  An empty / original id resolves with no idOverride (=> overwrite). */
    private async promptCustomDeploy(meta: { id: string; name: string; version: string }): Promise<{ idOverride?: string; nameOverride?: string } | undefined> {
        const digits = (meta.version || "").replace(/[^0-9]/g, "");
        const suf = digits ? "v" + digits : "";
        const defaultId = suf ? `${meta.id}.${suf}` : meta.id;
        const defaultName = suf ? `${meta.name}${suf.toUpperCase()}` : meta.name;
        return new Promise<{ idOverride?: string; nameOverride?: string } | undefined>((resolve) => {
            const panel = vscode.window.createWebviewPanel(
                "boosterMatch.customDeploy",
                t("customDeployTitle"),
                vscode.ViewColumn.Active,
                { enableScripts: true },
            );
            let done = false;
            const finish = (result: { idOverride?: string; nameOverride?: string } | undefined) => {
                if (done) { return; }
                done = true;
                panel.dispose();
                resolve(result);
            };
            panel.onDidDispose(() => finish(undefined));
            panel.webview.onDidReceiveMessage((m: any) => {
                if (m.type === "cancel") { finish(undefined); return; }
                if (m.type === "submit") {
                    const id = String(m.id || "").trim();
                    const name = String(m.name || "").trim();
                    const nameOverride = name && name !== meta.name ? name : undefined;
                    if (!id || id === meta.id) {
                        finish({ idOverride: undefined, nameOverride });
                    } else {
                        finish({ idOverride: id, nameOverride });
                    }
                }
            });
            panel.webview.html = this.customDeployHtml(meta, defaultId, defaultName, suf);
        });
    }

    private customDeployHtml(meta: { id: string; name: string }, defaultId: string, defaultName: string, suf: string): string {
        const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
        const hint = t("customDeployHint").replace("{id}", esc(meta.id)).replace("{suf}", suf ? "." + suf : "");
        const invalidMsg = JSON.stringify(t("customDeployIdInvalid"));
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:20px;margin:0}
h2{margin:0 0 8px;font-weight:600;font-size:15px}
.hint{font-size:12px;opacity:.8;margin-bottom:14px;line-height:1.5}
.hint code{background:var(--vscode-textBlockQuote-background);padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family)}
label{display:block;font-size:11px;text-transform:uppercase;opacity:.7;margin:12px 0 4px;font-weight:600}
input{width:100%;padding:7px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:13px;font-family:var(--vscode-editor-font-family);box-sizing:border-box}
input:focus{outline:none;border-color:var(--vscode-focusBorder)}
.err{font-size:11px;color:var(--vscode-errorForeground);min-height:14px;margin-top:3px}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
button{padding:6px 18px;border:none;border-radius:3px;cursor:pointer;font-size:13px}
.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.btn-primary:hover{background:var(--vscode-button-hoverBackground)}
.btn-primary:disabled{opacity:.4;cursor:default}
.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
</style></head><body>
<h2>${t("customDeployTitle")}</h2>
<div class="hint">${hint}</div>
<label for="fId">${t("customDeployIdLabel")}</label>
<input id="fId" value="${esc(defaultId)}">
<div class="err" id="fErr"></div>
<label for="fName">${t("customDeployNameLabel")}</label>
<input id="fName" value="${esc(defaultName)}">
<div class="actions">
<button class="btn-secondary" id="bCancel">${t("customDeployCancel")}</button>
<button class="btn-primary" id="bOk">${t("customDeployOk")}</button>
</div>
<script>
const vscode=acquireVsCodeApi();
const idEl=document.getElementById('fId'),nameEl=document.getElementById('fName'),errEl=document.getElementById('fErr'),okBtn=document.getElementById('bOk'),cancelBtn=document.getElementById('bCancel');
const RX=/^[a-zA-Z][a-zA-Z0-9.]*$/;
function chk(){var v=idEl.value.trim();var ok=v===''||RX.test(v);errEl.textContent=ok?'':${invalidMsg};okBtn.disabled=!ok;return ok;}
idEl.addEventListener('input',chk);
cancelBtn.addEventListener('click',()=>vscode.postMessage({type:'cancel'}));
okBtn.addEventListener('click',()=>{if(!chk())return;vscode.postMessage({type:'submit',id:idEl.value,name:nameEl.value});});
window.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();if(!okBtn.disabled){okBtn.click();}}else if(e.key==='Escape'){cancelBtn.click();}});
chk();
idEl.focus();idEl.select();
</script>
</body></html>`;
    }

    /** If the selected agent is a local .agent file, deploy it to the container
     *  first so run.py can find it under agent.json.id. Container agents are
     *  returned as-is. */
    private async ensureDeployed(agentId: string): Promise<string> {
        const agent = this.agents.find((a) => a.id === agentId);
        if (agent && agent.source === "file" && agent.path) {
            this.output.appendLine(`  Deploying local .agent file: ${agent.path}`);
            return await deployAgentFile(agent.path, undefined, undefined, (s) => this.diagLine(s));
        }
        return agentId;
    }

    /** Deploy local .agent files (if any), then clone blue team if both sides
     *  picked the same agent (avoids ROS2 package-name collision). */
    private async deployAndClone(): Promise<{ team1Id: string; team2Id: string }> {
        let team1Id = await this.ensureDeployed(this.selection.red);
        let team2Id = await this.ensureDeployed(this.selection.blue);
        if (team1Id === team2Id) {
            const cloneId = `${team2Id}.blue`;
            await cloneAgent(team2Id, cloneId, (s) => this.diagLine(s));
            team2Id = cloneId;
            await this.refresh();
        }
        return { team1Id, team2Id };
    }

    /** Append a diagnostics line to the output channel and reveal it — the
     *  forensics sink for the rename self-check during custom-id deploy/clone. */
    private diagLine(s: string): void {
        this.output.show(true);
        this.output.appendLine(s);
    }

    /** Is the football3v3_runner run.py process still alive? */
    private async runnerAlive(): Promise<boolean> {
        try {
            const out = await dockerExec("pgrep -f 'run.py.*--teams' 2>/dev/null", 4000);
            return out.trim().length > 0;
        } catch { return false; }
    }

    /** Kill leftover team-agent processes from a previous match — both the
     *  `ros2 launch <pkg> launch.py` parents AND their `pyagent_x86` children —
     *  while preserving the system daemon (`booster_agent_manager`) and the
     *  default demo agent (`com.boosterobotics.default`, guarded by
     *  agent_manager).
     *
     *  WHY this is needed: `ros2 launch` is the PARENT of pyagent, so the
     *  existing `pkill pyagent_x86` only kills the child node and leaves the
     *  `ros2 launch` parent behind. Its cgroup was already `rm -rf`'d, so it
     *  runs on as an unmanaged orphan still holding the ROS2 node / package /
     *  topic names. On the next match the new agent cannot bind those names →
     *  pyagent fails to start → robots don't move. `/match/end` also does NOT
     *  destroy team sandboxes, so without this the orphans accumulate.
     *
     *  The `boosterobotics.*default` exclusion matches BOTH the dotted agent
     *  path (com.boosterobotics.default pyagent) and the underscored ROS2
     *  package name (com_boosterobotics_default launch) — without it the
     *  default's pyagent (dotted path) would be mis-killed. Idempotent and
     *  harmless when nothing matches (xargs -r skips empty input). */
    private async killTeamAgentLaunches(): Promise<void> {
        await dockerExec(
            "ps -eo pid,args | grep -E 'ros2 launch|pyagent' | " +
            "grep -vE 'booster_agent_manager|boosterobotics.*default|grep' | " +
            "awk '{print $1}' | xargs -r kill -9 2>/dev/null; true",
            8000
        ).catch(() => {});
    }

    private async restartRunnerWithTeams(team1: string, team2: string): Promise<void> {
        this.saveCurrentTeams(team1, team2);
        this.output.appendLine("  Stopping old runner...");
        await dockerExec("pkill -9 -f football3v3; pkill -9 -f 'run.py.*teams'; pkill -9 -f pyagent_x86; sleep 2", 10000).catch(() => {});
        // pkill pyagent_x86 above only kills the agent NODES (children); their
        // `ros2 launch` parents survive as orphans (cgroup already removed) and
        // keep holding the ROS2 node/package names, so the new match's agents
        // can't bind and robots don't move. Kill the launch parents too.
        // Defensive: also covers reload/crash cases where endMatch never ran.
        await this.killTeamAgentLaunches();
        // Clean stale sandboxes leaked by previous crashed runs (keep team_1 /
        // team_2 for the new run). /run is a tmpfs, so leaked sandboxes from
        // crashed runs accumulate and can starve the next sandbox.create().
        // Harmless when none exist. The real "robots don't move" root cause is
        // on the Booster Studio side — handled by the restart hint, not here.
        await dockerExec("find /run/3v3_runner -maxdepth 1 -mindepth 1 -type d ! -name team_1 ! -name team_2 -exec rm -rf {} + 2>/dev/null", 8000).catch(() => {});
        await dockerExec("rm -rf /sys/fs/cgroup/3v3_runner/team_1 /sys/fs/cgroup/3v3_runner/team_2 2>/dev/null", 5000).catch(() => {});

        // Wrapper just cds into the runner dir and execs run.py. pyagent's ROS2
        // env is supplied by the ros_env.sh export patch below (login shells source
        // it) and run.py's own load_runtime_env() (from agent_manager). The earlier
        // source-setup.bash + _env_merge.py steps were dead code — overwritten by
        // run.py — so they are removed.
        const wrapperLines = [
            "#!/bin/bash",
            "cd /usr/local/booster_agent/football3v3_runner",
            `exec python3 run.py --publish-logs --teams ${team1} ${team2}`,
        ];
        const wrapperB64 = Buffer.from(wrapperLines.join("\n") + "\n").toString("base64");
        await dockerExec(`echo ${wrapperB64} | base64 -d > /tmp/_run3v3.sh && chmod +x /tmp/_run3v3.sh`, 5000);

        // ROOT-CAUSE FIX (robots don't move): ros_env.sh's base exports lack the
        // BoosterAgent paths pyagent needs (libbooster_agent_pyruntime.so), so
        // pyagent died on import. v0.8.3 fixed this by appending
        // `source .../setup.bash` — but setup.bash takes ~3s to source, and
        // ros_env.sh is sourced by EVERY login shell. sandbox.create()'s bootstrap
        // runs TWO login shells before touching ready_file, so the 5s wait_path
        // timed out non-deterministically → "failed to initialize sandbox" → run.py
        // destroyed both sandboxes → no pyagent on the field → robots don't move.
        // FIX: source setup.bash ONCE here, then write the resolved env back as
        // plain `export` lines. login shells stay fast (~10ms), pyagent still gets
        // the full env. Idempotent: re-runs strip the old patch block first.
        const rosPatchScript = [
            "#!/bin/bash",
            "set -e",
            "RS=/etc/profile.d/ros_env.sh",
            '# strip any prior booster-match-runner patch (source- or export-based)',
            'grep -vE "booster-match-runner|Booster match-runner|source /opt/(ros/humble|booster/BoosterRos2/install|booster/BoosterAgent/install)/setup\\.bash" "$RS" > /tmp/_rs.clean || true',
            "# resolve the full env once by sourcing the slow setup.bash",
            "source /opt/ros/humble/setup.bash 2>/dev/null",
            "source /opt/booster/BoosterRos2/install/setup.bash 2>/dev/null",
            "source /opt/booster/BoosterAgent/install/setup.bash 2>/dev/null",
            "# write it back as fast export lines (keeps login shells sub-50ms)",
            "{",
            '  printf "\\n"',
            '  echo "# booster-match-runner-export: full ROS2 env via export (keeps login shells fast)"',
            '  echo "export AMENT_PREFIX_PATH=$AMENT_PREFIX_PATH"',
            '  echo "export PYTHONPATH=$PYTHONPATH"',
            '  echo "export LD_LIBRARY_PATH=$LD_LIBRARY_PATH"',
            "} >> /tmp/_rs.clean",
            'mv /tmp/_rs.clean "$RS"',
        ];
        const rosPatchB64 = Buffer.from(rosPatchScript.join("\n") + "\n").toString("base64");
        await dockerExec(
            `echo ${rosPatchB64} | base64 -d > /tmp/_patch_ros.sh && bash /tmp/_patch_ros.sh`,
            15000
        ).catch(() => {});

        this.output.appendLine(`  Starting: ${team1} vs ${team2}`);
        await dockerExecDetached("bash /tmp/_run3v3.sh");

        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 5000));
            // If run.py died, fail fast instead of waiting the full 75s. The
            // usual root cause is on the Booster Studio side (stale injected
            // runtime / ROS bridge), not something we can fix from inside the
            // container — prompt the user to restart Booster Studio.
            if (!await this.runnerAlive()) {
                await this.dumpMatchStartDiagnostics("runner exited");
                const msg = t("runnerDied");
                this.output.appendLine("  " + msg);
                throw new Error(msg);
            }
            this.output.appendLine(`  Health ${i + 1}/15...`);
            try {
                const h = await gameControlApi("/health", "GET", 5000);
                if (h.ready === true && h.checks?.team1 === true && h.checks?.team2 === true) {
                    this.output.appendLine("  Ready!"); return;
                }
            } catch { /* wait */ }
        }
        await this.dumpMatchStartDiagnostics("not ready in 75s");
        throw new Error(t("runnerNotReady"));
    }

    /** Dump match-start failure forensics to the output channel AND persist it
     *  to ~/.booster-match-runner/match-start-failure.log (overwritten each
     *  failure) so the user can find it even after a reload. Captures run.py
     *  log tail, last /health response, sandbox dirs, and live processes at the
     *  moment of failure — pure diagnostics, no root-cause assumption. */
    private async dumpMatchStartDiagnostics(reason: string): Promise<void> {
        const lines: string[] = [`--- diagnostics: ${reason} ---`];
        try {
            const log = await dockerExec("tail -40 /usr/local/booster_agent/football3v3_runner/football3v3-run.log 2>/dev/null", 5000);
            lines.push("[run.py log tail]");
            for (const l of log.split("\n").filter(Boolean)) { lines.push("  " + l); }
        } catch { lines.push("[run.py log tail] <unavailable>"); }
        try {
            const h = await gameControlApi("/health", "GET", 5000);
            lines.push(`[health] ${JSON.stringify(h)}`);
        } catch { lines.push("[health] <unavailable>"); }
        try {
            const sb = await dockerExec("ls /run/3v3_runner/ 2>/dev/null", 4000);
            const dirs = sb.split("\n").map((s) => s.trim()).filter(Boolean).join(", ");
            lines.push(`[sandboxes] ${dirs || "<none>"}`);
        } catch { lines.push("[sandboxes] <unavailable>"); }
        try {
            const ps = await dockerExec("pgrep -af 'run.py|pyagent|ros2 launch' 2>/dev/null | grep -v pgrep", 4000);
            const psLines = ps.split("\n").map((s) => s.trim()).filter(Boolean);
            lines.push("[processes]");
            for (const l of psLines) { lines.push("  " + l); }
            if (!psLines.length) { lines.push("  <none matching>"); }
        } catch { lines.push("[processes] <none matching>"); }
        lines.push("--- end diagnostics ---");
        for (const l of lines) { this.output.appendLine("  " + l); }
        try {
            const dir = path.join(os.homedir(), ".booster-match-runner");
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, "match-start-failure.log");
            await fs.promises.writeFile(file, lines.join("\n") + "\n", "utf8");
            this.output.appendLine(`  [diagnostics saved to ${file}]`);
        } catch { /* best effort — output channel already has it */ }
    }

    private getEventsLogPath(): string {
        return EVENTS_LOG_PATH;
    }

    private postEventsToView(): void {
        const recent = this.currentEvents.slice(-50).reverse();
        this.postMessage({ type: "events", events: recent });
    }

    /** Always append a synthetic "match finished" event when the match ends,
     *  regardless of manual / automatic / external end. */
    private appendFinishEvent(status: MatchStatus): void {
        this.currentEvents.push({
            eventId: "local-finish",
            wallTime: status.endedAtWallTime ?? Math.floor(Date.now() / 1000),
            type: "match_finished",
            icon: "🏁",
            actorSide: null,
            actorName: null,
            scoreHome: status.score.home,
            scoreAway: status.score.away,
        });
        this.postEventsToView();
    }

    /** Append a synthetic event describing why a match was ended early by config
     *  (leadGoals / matchLength). Pre-localized so the webview shows it verbatim. */
    private appendEarlyEndEvent(reason: "lead_goals" | "match_length", status: MatchStatus, leadGoals: number, matchLength: number): void {
        const zh = getLang() === "zh";
        const diff = Math.abs(status.score.home - status.score.away);
        const text = reason === "lead_goals"
            ? (zh ? `提前结束：领先达到 ${diff} 球（≥ 配置 leadGoals=${leadGoals}）` : `Auto-ended: lead reached ${diff} (≥ leadGoals=${leadGoals})`)
            : (zh ? `提前结束：时长 ${status.durationSeconds.toFixed(0)}s（≥ 配置 matchLength=${matchLength}s）` : `Auto-ended: duration ${status.durationSeconds.toFixed(0)}s (≥ matchLength=${matchLength}s)`);
        this.currentEvents.push({
            eventId: "local-early-end",
            wallTime: Math.floor(Date.now() / 1000),
            type: "early_end",
            icon: "🛑",
            text,
            actorSide: null,
            actorName: null,
            scoreHome: status.score.home,
            scoreAway: status.score.away,
        });
        this.postEventsToView();
    }

    private agentName(id: string): string {
        return this.agents.find((a) => a.id === id)?.name || id;
    }

    /** Build the match zip (summary + events + run log) from current state. */
    private async buildMatchZip(mode?: MatchMode): Promise<AdmZip> {
        const st = this.lastStatus;
        const summary = {
            savedAt: new Date().toISOString(),
            mode: mode ?? null,
            red: { id: this.selection.red, name: this.agentName(this.selection.red) },
            blue: { id: this.selection.blue, name: this.agentName(this.selection.blue) },
            redScore: st ? st.score.home : null,
            blueScore: st ? st.score.away : null,
            state: st ? st.state : null,
            phase: st ? st.phase : null,
            durationSeconds: st ? st.durationSeconds : null,
            startedAtWallTime: st ? st.startedAtWallTime : null,
            endedAtWallTime: st ? st.endedAtWallTime : null,
        };
        const redName = this.agentName(this.selection.red);
        const blueName = this.agentName(this.selection.blue);
        const eventsText = this.currentEvents.map((e) => {
            const name = e.actorSide === "home" ? redName : e.actorSide === "away" ? blueName : "";
            return `${new Date(e.wallTime * 1000).toISOString()}  ${e.icon} ${eventLabel(e.type)}` +
                (name ? ` [${name}]` : "") + `  ${e.scoreHome}-${e.scoreAway}`;
        }).join("\n");

        let matchLog = "";
        try {
            matchLog = await dockerExec("cat /usr/local/booster_agent/football3v3_runner/football3v3-run.log 2>/dev/null", 8000);
        } catch { /* no log available */ }

        const zip = new AdmZip();
        zip.addFile("summary.json", Buffer.from(JSON.stringify(summary, null, 2), "utf8"));
        zip.addFile("events.json", Buffer.from(JSON.stringify(this.currentEvents, null, 2), "utf8"));
        zip.addFile("events.txt", Buffer.from(eventsText + "\n", "utf8"));
        if (matchLog.trim()) {
            zip.addFile("match.log", Buffer.from(matchLog, "utf8"));
        }
        return zip;
    }

    private timestampName(): string {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    /** Pack score/time/agents/run-log/events into a zip for the user to save. */
    async saveLog() {
        let zip: AdmZip;
        try { zip = await this.buildMatchZip(); }
        catch (err: any) { vscode.window.showErrorMessage("Build zip failed: " + err.message); return; }
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`match-${this.timestampName()}.zip`),
            filters: { "Zip": ["zip"] },
            title: "Save match log",
        });
        if (!uri) { return; }
        try {
            zip.writeZip(uri.fsPath);
            vscode.window.showInformationMessage(`Saved: ${uri.fsPath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage("Save failed: " + err.message);
        }
    }

    private recordsDir(): string {
        return path.join(os.homedir(), ".booster-match-runner", "matches");
    }

    private async readRecords(): Promise<MatchRecord[]> {
        try {
            const data = await fs.promises.readFile(path.join(this.recordsDir(), "records.json"), "utf8");
            const raw = JSON.parse(data);
            return (Array.isArray(raw) ? raw : []).map((r: any) => ({
                ...r,
                mode: r.mode === MODE_VISUAL ? MODE_VISUAL : MODE_HEADLESS,
                redScore: r.redScore ?? r.score?.home ?? 0,
                blueScore: r.blueScore ?? r.score?.away ?? 0,
            }));
        } catch { return []; }
    }

    private async appendRecord(record: MatchRecord): Promise<void> {
        await fs.promises.mkdir(this.recordsDir(), { recursive: true });
        const records = await this.readRecords();
        records.push(record);
        await fs.promises.writeFile(path.join(this.recordsDir(), "records.json"), JSON.stringify(records, null, 2), "utf8");
    }

    /** Probe whether ffmpeg is runnable on the host PATH (required by video recording). */
    private detectFfmpeg(): Promise<boolean> {
        return new Promise((resolve) => {
            cp.execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err) => resolve(!err));
        });
    }

    /** UI-mode window recording: crop a gdigrab desktop capture to the Booster
     *  Studio window → direct MP4 (includes the score HUD + robot skins the
     *  viewer shows). Window must stay foreground (gdigrab captures the screen). */
    private async startWindowRecordingIfEnabled(): Promise<boolean> {
        const cfg = vscode.workspace.getConfiguration("boosterMatch");
        if (!cfg.get<boolean>("recordVideo", false)) { return false; }
        const mp4 = path.join(this.recordsDir(), `match-${this.timestampName()}.mp4`);
        this.windowRecorder = new WindowRecorder(this.context.asAbsolutePath(path.join("scripts", "window_rect.ps1")), this.context.asAbsolutePath(path.join("scripts", "window_rect.sh")));
        this.output.appendLine(`  [rec-window] starting: ${path.basename(mp4)}`);
        const ok = await this.windowRecorder.start(mp4).catch((e: any) => {
            this.output.appendLine("  [rec-window] start failed: " + e.message); return false;
        });
        if (ok) {
            this.windowMp4Path = mp4;
        } else {
            this.windowMp4Path = null;
            this.windowRecorder = null;
            this.output.appendLine("  [rec-window] did not start (needs a foreground Booster Studio window + ffmpeg on PATH).");
        }
        return ok;
    }

    private async stopWindowRecording(): Promise<void> {
        const rec = this.windowRecorder;
        if (!rec) { return; }
        const ok = await rec.stop().catch(() => false);
        this.windowRecorder = null;
        if (ok && this.windowMp4Path) { this.output.appendLine(`  [rec-window] recorded temp: ${this.windowMp4Path}`); }
        // windowMp4Path is kept so autoSaveRecord can rename it alongside the zip.
    }

    /** Auto-save the just-finished match into the records dir and append to the index. */
    private async autoSaveRecord(mode: MatchMode): Promise<void> {
        try {
            const fresh = await getMatchStatus();
            if (fresh) { this.lastStatus = fresh; }
        } catch { /* keep last known status */ }
        const st = this.lastStatus;
        let zip: AdmZip;
        try { zip = await this.buildMatchZip(mode); }
        catch { return; }
        await fs.promises.mkdir(this.recordsDir(), { recursive: true });
        const scoreSuffix = st ? `_${st.score.home}-${st.score.away}` : "";
        const tsName = this.timestampName();
        // match-<ts>_<red>_vs_<blue><score>.zip|.mp4 — sanitize team names for the filesystem.
        const cleanName = (s: string) => s.replace(/[/\\:*?"<>|\s]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "x";
        const namePart = `_${cleanName(this.agentName(this.selection.red) || "Red")}_vs_${cleanName(this.agentName(this.selection.blue) || "Blue")}`;
        const base = `match-${tsName}${namePart}${scoreSuffix}`;
        const zipPath = path.join(this.recordsDir(), `${base}.zip`);
        try {
            zip.writeZip(zipPath);
        } catch (err: any) {
            this.output.appendLine("  Auto-save failed: " + err.message);
            return;
        }
        // Rename the UI-mode window recording so it sits next to the zip with the same name.
        if (this.windowMp4Path && fs.existsSync(this.windowMp4Path)) {
            const mp4Final = path.join(this.recordsDir(), `${base}.mp4`);
            try { fs.renameSync(this.windowMp4Path, mp4Final); this.windowMp4Path = mp4Final; }
            catch (err: any) { this.output.appendLine("  mp4 rename failed: " + err.message); }
        }
        const record: MatchRecord = {
            zipPath,
            savedAt: new Date().toISOString(),
            mode,
            red: { id: this.selection.red, name: this.agentName(this.selection.red) },
            blue: { id: this.selection.blue, name: this.agentName(this.selection.blue) },
            redScore: st ? st.score.home : 0,
            blueScore: st ? st.score.away : 0,
            startedAtWallTime: st ? st.startedAtWallTime : null,
            endedAtWallTime: st ? st.endedAtWallTime : null,
        };
        await this.appendRecord(record);
        this.output.appendLine(`  Saved record: ${zipPath}`);
    }

    /** List saved match records; pick one to reveal in the system file manager,
     *  or export all to CSV via the first entry. */
    async showRecords() {
        const records = await this.readRecords();
        if (!records.length) {
            vscode.window.showInformationMessage("No match records yet.");
            return;
        }
        const items: any[] = [
            { kind: "export", label: t("exportAll"), description: `${records.length} records` },
            ...records.slice().reverse().map((r) => ({
                kind: "match",
                label: `${r.redScore}-${r.blueScore}  ${r.red.name} vs ${r.blue.name}`,
                description: `${r.mode} · ${r.savedAt ? fmtShanghai(r.savedAt) : "?"}`,
                zipPath: r.zipPath,
            })),
        ];
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: "Match records — select to open folder, or export all to CSV",
        });
        if (!pick) { return; }
        if (pick.kind === "export") {
            await this.exportRecordsCsv(records);
        } else {
            vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pick.zipPath));
        }
    }

    /** Export all match records to a CSV file (Excel-friendly, UTF-8 BOM). */
    private async exportRecordsCsv(records: MatchRecord[]): Promise<void> {
        const cols = (vals: (string | number)[]) =>
            vals.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
        const csv = [
            cols(["savedAt", "startedAt", "endedAt", "redAgent", "blueAgent", "redScore", "blueScore", "zipPath", "mode"]),
            ...records.map((r) => cols([
                fmtShanghai(r.savedAt),
                r.startedAtWallTime != null ? fmtShanghai(r.startedAtWallTime * 1000) : "",
                r.endedAtWallTime != null ? fmtShanghai(r.endedAtWallTime * 1000) : "",
                r.red.name,
                r.blue.name,
                r.redScore,
                r.blueScore,
                r.zipPath,
                r.mode,
            ])),
        ].join("\n");
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`match-records-${this.timestampName()}.csv`),
            filters: { "CSV": ["csv"] },
            title: "Export match records",
        });
        if (!uri) { return; }
        try {
            await fs.promises.writeFile(uri.fsPath, "﻿" + csv, "utf8");
            vscode.window.showInformationMessage(`Exported: ${uri.fsPath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage("Export failed: " + err.message);
        }
    }

    /** Reset event tracking at match start: baseline = current line count, clear list. */
    private async resetEventTracking(): Promise<void> {
        this.eventsLogPath = this.getEventsLogPath();
        this.baseLineCount = await getBaseLineCount(this.eventsLogPath).catch(() => 0);
        this.currentEvents = [];
        this.finishEventAdded = false;
        this.autoEnded = false;
    }

    /** Recover event tracking after reload/reopen: baseline = last match_started line,
     *  so we resume from the CURRENT match even if monitorMatch was interrupted. */
    private async recoverEventTracking(): Promise<void> {
        this.eventsLogPath = this.getEventsLogPath();
        this.finishEventAdded = false;
        this.autoEnded = false;
        const out = await dockerExec(
            `grep -n '"type":"match_started"' ${shellQuote(this.eventsLogPath)} | tail -1 | cut -d: -f1`,
            8000
        ).catch(() => "");
        const line = parseInt((out || "").trim(), 10);
        this.baseLineCount = Number.isFinite(line) && line > 0 ? line - 1 : 0;
        try {
            this.currentEvents = dedupeByEventId(await readNewEvents(this.eventsLogPath, this.baseLineCount));
        } catch { this.currentEvents = []; }
    }

    /** Independent UI poll (status + events). Survives monitorMatch interruption
     *  because it's driven by resolveWebviewView, not the startMatch call stack. */
    private startPolling(): void {
        this.stopPolling();
        this.pollTimer = setInterval(() => { void this.pollOnce(); }, 3000);
    }

    private stopPolling(): void {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    }

    private async pollOnce(): Promise<void> {
        let status: MatchStatus;
        try { status = await getMatchStatus(); }
        catch { return; }
        const active = status.state === "playing" || status.state === "ready" || status.state === "set";
        // Detect match switch (new match, possibly started outside this panel or
        // after a reload): re-baseline to the current match so event list, score
        // and time all refer to the SAME match. eventId resets each match
        // (local-match:N), so without this the list mixes old + new events; and
        // matchReset clears the locked score left by the previous finished match.
        if (status.startedAtWallTime != null && status.startedAtWallTime !== this.matchStartedAt) {
            const isSwitch = this.matchStartedAt !== null;
            this.matchStartedAt = status.startedAtWallTime;
            if (isSwitch) { this.postMessage({ type: "matchReset" }); }
            await this.recoverEventTracking();
            if (this.currentEvents.length) { this.postEventsToView(); }
        }
        this.postMessage({ type: "status", status, teams: this.currentTeamsInfo() });
        this.lastStatus = status;
        if (status.isFinished && !this.finishEventAdded) {
            this.finishEventAdded = true;
            this.appendFinishEvent(status);
        }
        // Reload-safe auto-end on leadGoals / matchLength. monitorMatch does NOT
        // survive reload, so this independent poll owns auto-ending (a match
        // started before reload would otherwise never auto-end). Fires at most
        // once per match (autoEnded resets in reset/recoverEventTracking).
        if (active && !status.isFinished && !this.autoEnded && !this.startingNew) {
            const cfg = vscode.workspace.getConfiguration("boosterMatch");
            const leadGoals = cfg.get<number>("leadGoals", 0);
            const matchLength = cfg.get<number>("matchLength", 0);
            let reason: "lead_goals" | "match_length" | null = null;
            if (leadGoals > 0 && Math.abs(status.score.home - status.score.away) >= leadGoals) {
                reason = "lead_goals";
            } else if (matchLength > 0 && status.durationSeconds >= matchLength) {
                reason = "match_length";
            }
            if (reason) {
                this.autoEnded = true;
                this.appendEarlyEndEvent(reason, status, leadGoals, matchLength);
                this.output.appendLine(`Auto-end triggered (${reason}), ending match...`);
                // Only stop the sim — do NOT call this.endMatch(). endMatch sets
                // isRunning=false, which would kill an in-progress batch (Count>1):
                // the loop's `if (!isRunning) break` would abort the whole queue
                // after the first match. monitorMatch sees isFinished on the next
                // poll and exits on its own, so the batch can start the next match.
                try { await apiEndMatch(); } catch { /* ignore */ }
            }
        }
        if (!active) { return; }
        try {
            const fresh = await readNewEvents(this.eventsLogPath, this.baseLineCount);
            if (fresh.length) {
                const seen = new Set(this.currentEvents.map((e) => e.eventId));
                let added = false;
                for (const ev of fresh) {
                    if (ev.eventId && !seen.has(ev.eventId)) {
                        this.currentEvents.push(ev);
                        seen.add(ev.eventId);
                        added = true;
                    }
                }
                if (added) { this.postEventsToView(); }
            }
        } catch { /* events are optional */ }
    }

    private postMessage(msg: any) {
        if (this.view) { this.view.webview.postMessage(msg); }
    }

    /** Push the current i18n bundle so the webview can (re)translate its UI. */
    private postI18n(): void {
        this.postMessage({ type: "i18n", bundle: getI18nBundle() });
    }

    private getHtml(): string {
        const recVideo = vscode.workspace.getConfiguration("boosterMatch").get<boolean>("recordVideo", false);
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:10px}
.section{margin-bottom:14px}
.label{font-size:11px;text-transform:uppercase;opacity:.7;margin-bottom:4px;font-weight:600}
select{width:100%;padding:5px 8px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:3px;font-size:12px}
.tr{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot.r{background:#e74c3c}.dot.b{background:#3498db}
.sd{display:flex;align-items:center;justify-content:center;gap:8px;padding:16px 8px;background:var(--vscode-editor-background);border-radius:6px}
.st{flex:1;text-align:center}.st .n{font-size:10px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st .s{font-size:32px;font-weight:bold}.st.r .s{color:#e74c3c}.st.b .s{color:#3498db}
.vs{font-size:12px;opacity:.4}
.btn{display:block;width:100%;padding:8px 12px;margin-bottom:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;text-align:center}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn:disabled{opacity:.4;cursor:default}
.btn.icb{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:6px 2px}
.btn.icb .ic{font-size:16px;line-height:1}
.btn.icb .lb{font-size:10px;line-height:1.2;white-space:nowrap}
.sb{font-size:10px;opacity:.5;text-align:center;padding:4px}.sb.run{color:#2ecc71;opacity:.8}
.tm{font-size:11px;opacity:.75;line-height:1.6}.tm .lab{display:inline-block;width:3em;opacity:.55}
.ev{max-height:240px;overflow-y:auto;margin-top:4px}.ev .row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;border-bottom:1px solid rgba(128,128,128,.12)}.ev .row .ic{width:18px;text-align:center;flex-shrink:0}.ev .row .t{opacity:.55;flex-shrink:0}.ev .row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ev .row .nm.r{color:#e74c3c}.ev .row .nm.b{color:#3498db}.ev .row .sc{opacity:.5;flex-shrink:0}.ev .empty{opacity:.4;font-size:11px;padding:10px 0;text-align:center}
.cw{background:rgba(231,76,60,.1);border:1px solid rgba(231,76,60,.3);border-radius:4px;padding:10px;text-align:center;font-size:11px;margin-bottom:8px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px}
@keyframes sp{to{transform:rotate(360deg)}}
</style></head><body>
<div style="display:flex;justify-content:flex-end;gap:4px;margin-bottom:4px"><button id="langBtn" class="btn s" style="width:auto;padding:3px 12px;font-size:11px" onclick="toggleLang()">中</button><button id="settingsBtn" class="btn s" style="width:auto;padding:3px 10px;font-size:12px" onclick="s('openSettings')" title="Settings">&#9881;</button></div>
<div class="section"><div class="label" id="lblScore">Score</div>
<div class="sd"><div class="st r"><div class="n" id="rn">Red</div><div class="s" id="rs">0</div></div>
<div class="vs">VS</div>
<div class="st b"><div class="n" id="bn">Blue</div><div class="s" id="bs">0</div></div></div>
<div class="tm"><span class="lab" id="lblStart">Start</span><span id="tStart">—</span></div>
<div class="tm"><span class="lab" id="lblClock">Clock</span><span id="tClock">—</span></div>
<div class="tm"><span class="lab" id="lblPlay">Play</span><span id="tPlay">—</span></div>
<div class="tm"><span class="lab" id="lblEnd">End</span><span id="tEnd">—</span></div>
</div>
<div id="cwarn" class="cw" style="display:none"><span id="cwTxt">Container not running.</span><br><button class="btn" style="margin-top:6px" id="btnStartContainer" onclick="s('startContainer')">Start Container</button><div id="cwLoading" style="display:none;margin-top:8px"><span class="spin"></span> <span id="cwLoadingTxt">Starting container...</span></div></div>
<div class="section" id="ts"><div class="label" id="lblTeams">Teams</div>
<div class="tr"><div class="dot r"></div><select id="rsel" onchange="sel('red',this.value)"><option value="" id="optRed">Loading...</option></select></div>
<div class="tr"><div class="dot b"></div><select id="bsel" onchange="sel('blue',this.value)"><option value="" id="optBlue">Loading...</option></select></div></div>
<div class="section">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:11px;opacity:.7;width:3em" id="lblCount">Count</span><input id="count" type="number" min="1" max="999" value="1" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:12px"><span id="progress" style="font-size:11px;opacity:.7;min-width:34px;text-align:center"></span><button class="btn s" id="btnRecords" style="flex:0 0 auto;width:auto;padding:5px 0 5px 10px;font-size:13px" onclick="s('showRecords')" title="Match records">&#128203; <span id="t_btnRecords">Records</span></button></div>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;opacity:.85;cursor:pointer"><input type="checkbox" id="recChk" ${recVideo ? "checked" : ""} onclick="s('toggleRecord')"> <span id="t_rec">Record video (UI mode only)</span></label>
<button class="btn" id="b1" onclick="sendStart('startVisual')">&#127944; <span id="t_b1">Start Match + UI</span></button>
<button class="btn s" id="b2" onclick="sendStart('startMatch')">&#9881; <span id="t_b2">Start Headless</span></button>
<div style="display:flex;gap:4px;margin-top:4px">
<button class="btn s" style="flex:1" id="bSim" onclick="s('openSim')">&#128064; <span id="t_openSim">UI</span></button>
<button class="btn s" style="flex:1" id="b3" onclick="s('endMatch')" disabled>&#9940; <span id="t_b3">End</span></button></div></div>
<div class="section"><div class="label" id="lblActions">Actions</div>
<div style="display:flex;gap:4px">
<button class="btn s icb" style="flex:1" onclick="s('refresh')" title="Refresh Agents"><span class="ic">&#8635;</span><span class="lb" id="t_refresh">Refresh</span></button>
<button class="btn s icb" style="flex:1" onclick="s('uploadAgent')" title="Upload Agent"><span class="ic">&#8682;</span><span class="lb" id="t_upload">Upload</span></button>
<button class="btn s icb" style="flex:1" onclick="s('saveLog')" title="Save Log"><span class="ic">&#128190;</span><span class="lb" id="t_save">Save</span></button>
<button class="btn s icb" style="flex:1" id="btnManageAgents" onclick="s('manageAgents')" title="Manage agents"><span class="ic">&#128203;</span><span class="lb" id="t_manageAgents">Manage</span></button>
<button class="btn s icb" style="flex:1" onclick="s('diagnose')" title="Diagnose environment"><span class="ic">&#128269;</span><span class="lb" id="t_diagnose">Diagnose</span></button>
</div></div>
<div class="section"><div class="label" id="lblKeyEvents">Key Events</div><div class="ev" id="evList"><div class="empty">No events yet</div></div></div>
<script>
const v=acquireVsCodeApi();
var panelState="idle";
var startingMatch=false;
var lastStatus=null,lastEvents=[];var lastTeams={red:{id:"",name:""},blue:{id:"",name:""}};
var I18N={lang:"en",msg:{score:"Score",teams:"Teams",actions:"Actions",keyEvents:"Key Events",start:"Start",end:"End",count:"Count",records:"Match records",noEvents:"No events yet",starting:"Starting…",containerUnreachable:"Container unreachable",containerNotRunning:"Container not running.",startContainer:"Start Container",startMatchUi:"Start Match + UI",startHeadless:"Start Headless",ui:"UI",refresh:"Refresh",upload:"Upload",save:"Save",loading:"Loading...",noAgents:"No agents",preparing:"Preparing…",red:"Red",blue:"Blue",manageAgents:"Manage",startingContainer:"Starting container…",recordVideo:"Record video (UI mode only)"},states:{playing:"Playing",ready:"Ready",set:"Set",finished:"Finished"},events:{}};
function T(k){return I18N.msg[k]||k}
function humanize(ty){return ty.split("_").map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1):w}).join(" ")}
function evLabel(ty){return I18N.events[ty]||humanize(ty)}
function stateLabel(s){return I18N.states[s]||s}
function toggleLang(){v.postMessage({type:"toggleLang"})}
function s(t){v.postMessage({type:t})}
function sendStart(t){var c=parseInt(document.getElementById('count').value)||1;v.postMessage({type:t,count:c})}
function sel(t,id){v.postMessage({type:"select"+t.charAt(0).toUpperCase()+t.slice(1),agentId:id})}
function fmtTime(sec,withDate){
  if(!sec||!isFinite(sec))return withDate?"—":"--:--:--";
  var d=new Date(sec*1000),p=function(n){return String(n).padStart(2,"0")};
  return withDate
    ?d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())
    :p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
function setText(id,txt){var el=document.getElementById(id);if(el)el.textContent=txt;}
function applyLang(){
  setText("lblScore",T("score"));
  setText("lblTeams",T("teams"));
  setText("lblActions",T("actions"));
  setText("lblKeyEvents",T("keyEvents"));
  setText("lblStart",T("start"));
  setText("lblEnd",T("end"));
  setText("lblClock",T("clock"));
  setText("lblPlay",T("play"));
  setText("lblCount",T("count"));
  setText("cwTxt",T("containerNotRunning"));
  setText("btnStartContainer",T("startContainer"));
  setText("t_manageAgents",T("manageAgents"));
  setText("t_diagnose",T("diagnose"));
  setText("cwLoadingTxt",T("startingContainer"));
  setText("t_b1",T("startMatchUi"));
  setText("t_b2",T("startHeadless"));
  setText("t_openSim",T("ui"));
  setText("t_b3",T("end"));
  setText("t_refresh",T("refresh"));
  setText("t_upload",T("upload"));
  setText("t_save",T("save"));
  setText("t_rec",T("recordVideo"));
  setText("optRed",T("loading"));
  setText("optBlue",T("loading"));
  document.getElementById("btnRecords").title=T("records");
  setText("t_btnRecords",T("records"));
  var ce=document.getElementById("count");if(ce)ce.title=T("countTip");
  document.getElementById("langBtn").textContent=I18N.lang==="en"?"中":"EN";
  var sb=document.getElementById("settingsBtn");if(sb)sb.title=T("settings");
  rs(lastStatus);
  renderEvents(lastEvents);
}
window.addEventListener("message",function(e){var m=e.data;switch(m.type){
case"i18n":I18N=m.bundle;applyLang();break;
case"agents":ra(m.agents,m.selection,m.containerRunning);break;
case"status":lastStatus=m.status;if(m.teams){lastTeams=m.teams;}rs(m.status);break;
case"matchReset":panelState="running";setScore(0,0);break;
case"status_text":{var el=document.getElementById("tEnd");if(el)el.textContent=m.text;break}
case"containerStarting":{var sb=document.getElementById("btnStartContainer"),ld=document.getElementById("cwLoading");if(m.starting){if(sb)sb.style.display="none";if(ld)ld.style.display="block";}else{if(sb)sb.style.display="";if(ld)ld.style.display="none";}break}
case"events":lastEvents=m.events;renderEvents(m.events);break;
case"batchProgress":{var pg=document.getElementById("progress");if(pg)pg.textContent=m.total>1?(m.current+"/"+m.total):"";break}
case"matchStarted":
  panelState="running";
  startingMatch=false;
  setScore(0,0);
  document.getElementById("tStart").textContent=T("starting");
  document.getElementById("tEnd").textContent=T("starting");
  d("b1",1);d("b2",1);d("b3",0);
  d("bSim",m.mode==="headless"?1:0);
  document.getElementById("rn").textContent=m.redName||"Red";
  document.getElementById("bn").textContent=m.blueName||"Blue";
  renderEvents([]);
  break;
case"matchStarting":
case"matchActive":
  panelState="running";
  d("b1",1);d("b2",1);d("b3",0);
  d("bSim",m.mode==="headless"?1:0);
  if(m.type==="matchStarting"){startingMatch=true;}
  break;
case"matchEnded":
  panelState="finished";
  startingMatch=false;
  d("b1",0);d("b2",0);d("b3",1);
  d("bSim",0);
  {var pg0=document.getElementById("progress");if(pg0)pg0.textContent="";}
  break;
case"recordVideoState":
  {var rc=document.getElementById("recChk");if(rc)rc.checked=!!m.value;}
  break;
}});
function d(id,dis){document.getElementById(id).disabled=dis}
function setScore(h,a){document.getElementById("rs").textContent=h;document.getElementById("bs").textContent=a}
function ra(a,sel,cr){
document.getElementById("cwarn").style.display=cr===false?"block":"none";
document.getElementById("ts").style.opacity=cr===false?".4":"1";
if(!a||!a.length){var na=T("noAgents");document.getElementById("rsel").innerHTML='<option value="">'+e(na)+'</option>';document.getElementById("bsel").innerHTML='<option value="">'+e(na)+'</option>';return;}
var o=a.map(function(x){var lbl=e(x.name);if(x.version){lbl+=" v"+e(x.version);}lbl+=" ("+x.source+" · "+e(x.id)+")";return'<option value="'+e(x.id)+'">'+lbl+"</option>"}).join("");
document.getElementById("rsel").innerHTML=o;document.getElementById("bsel").innerHTML=o;
if(sel){
document.getElementById("rsel").value=sel.red||"";document.getElementById("bsel").value=sel.blue||"";
var red=a.find(function(x){return x.id===sel.red});
var blue=a.find(function(x){return x.id===sel.blue});
if(red){document.getElementById("rn").textContent=red.name;}
if(blue){document.getElementById("bn").textContent=blue.name;}
}}
function rs(st){
if(!st){document.getElementById("tEnd").textContent=T("containerUnreachable");return;}
var active=st.state==="playing"||st.state==="ready"||st.state==="set";
if(panelState==="idle"){panelState=st.isFinished?"finished":(active?"running":"idle");}
if(st.isFinished&&!startingMatch){panelState="finished";d("b1",0);d("b2",0);d("b3",1);d("bSim",0);}
var updateScore=panelState!=="finished"||st.isFinished;
if(updateScore){setScore(st.score.home,st.score.away);}
document.getElementById("tStart").textContent=st.startedAtWallTime?fmtTime(st.startedAtWallTime,true):(active?T("preparing"):"—");
var endTxt;
if(st.endedAtWallTime){endTxt=fmtTime(st.endedAtWallTime,true);}
else if(st.isFinished){endTxt=stateLabel("finished");}
else if(active){endTxt=stateLabel("playing")+" · "+stateLabel(st.state);}
else{endTxt="—";}
document.getElementById("tEnd").textContent=endTxt;
renderLive(st,active);
}
function humanizeCamel(c){return c?String(c).replace(/([A-Z])/g," $1").replace(/^./,function(x){return x.toUpperCase()}).trim():c;}
function setPlayLabelP(c){return (I18N.setplays&&I18N.setplays[c])||humanizeCamel(c);}
function stageLabelP(c){return (I18N.stages&&I18N.stages[c])||humanizeCamel(c);}
function fmtClock(sec){if(sec==null||!isFinite(sec)||sec<0)return "--:--";var m=Math.floor(sec/60),s=Math.floor(sec%60);return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");}
function teamSpan(side){var t=side==="home"?lastTeams.red:lastTeams.blue;var nm=(t&&t.name)?t.name:(side==="home"?T("red"):T("blue"));var cl=side==="home"?"#e74c3c":"#3498db";return '<span style="color:'+cl+'">'+e(nm)+'</span>';}
function setHTML(id,html){var el=document.getElementById(id);if(el)el.innerHTML=html;}
function renderLive(st,active){
var clk="—";
if(active){
if(st.elapsedSeconds!=null&&isFinite(st.elapsedSeconds)){clk=fmtClock(st.elapsedSeconds);if(st.timingStage&&st.timingStage!=="regulation"){clk+=" ("+stageLabelP(st.timingStage)+")";}}
else{clk=stateLabel(st.state);}
}
setText("tClock",clk);
var pl="—";
if(st.stopped){pl=T("stopped");}
else if(st.isFinished&&st.winner){pl=T("winner")+": "+teamSpan(st.winner);}
else if(st.setPlay&&st.setPlay!=="noSetPlay"){pl=setPlayLabelP(st.setPlay);if(st.kickingSide){pl+=" · "+teamSpan(st.kickingSide);}}
else if(active){pl=stateLabel(st.state);}
setHTML("tPlay",pl);
}
function renderEvents(evs){
var el=document.getElementById("evList");
if(!evs||!evs.length){el.innerHTML='<div class="empty">'+T("noEvents")+'</div>';return;}
var homeName=document.getElementById("rn").textContent||T("red");
var awayName=document.getElementById("bn").textContent||T("blue");
var rows=evs.map(function(ev){
  var nm;
  var lbl=ev.text||evLabel(ev.type);
  if(ev.actorSide==="home"){nm='<span class="nm r">'+e(homeName)+" "+e(lbl)+"</span>";}
  else if(ev.actorSide==="away"){nm='<span class="nm b">'+e(awayName)+" "+e(lbl)+"</span>";}
  else{nm='<span class="nm">'+e(lbl)+"</span>";}
  return '<div class="row"><span class="ic">'+ev.icon+'</span><span class="t">'+fmtTime(ev.wallTime,false)+'</span>'+nm+'<span class="sc">'+ev.scoreHome+'-'+ev.scoreAway+'</span></div>';
}).join("");
el.innerHTML=rows;
}
function e(s){return String(s||"").replace(/[&<>"']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]})}
s("refresh")
</script></body></html>`;
    }
}