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
import { getBaseLineCount, readNewEvents, ParsedEvent, shellQuote } from "./eventReader";
import { initLang, toggleLang, getI18nBundle, t, eventLabel } from "./i18n";
import AdmZip from "adm-zip";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

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
    private output: vscode.OutputChannel;

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
                this.postMessage({ type: "matchActive" });
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
            this.postMessage({ type: "status", status });
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
            fs.writeFileSync(path.join(dir, "current-teams.json"), JSON.stringify({ red, blue, savedAt: Date.now() }, null, 2), "utf8");
        } catch { /* best effort */ }
    }

    private loadCurrentTeams(): { red: string; blue: string } | null {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".booster-match-runner", "current-teams.json"), "utf8"));
            if (d && d.red && d.blue) { return { red: String(d.red), blue: String(d.blue) }; }
        } catch { /* not present yet */ }
        return null;
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
            case "startVisual": await this.startVisualMatch(msg.timeout || 0, msg.lead || 0); break;
            case "startMatch": await this.startMatch(msg.count || 1, msg.timeout || 0, msg.lead || 0); break;
            case "endMatch": await this.endMatch(); break;
            case "openSim": await this.openSimulator(); break;
            case "uploadAgent": await this.uploadAgentFile(); break;
            case "startContainer": await this.startContainer(); break;
            case "manageAgents": await this.manageAgents(); break;
            case "saveLog": await this.saveLog(); break;
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
        const where = agent.source === "container" ? `container:${agent.path}` : agent.path;
        const choice = await vscode.window.showWarningMessage(
            `${t("confirmDelete")}\n${where}`,
            "Delete", "Cancel"
        );
        if (choice !== "Delete") { return; }
        try {
            if (agent.source === "container") {
                await dockerExec(`rm -rf "${agent.path}"`, 10000);
            } else if (agent.path) {
                await fs.promises.rm(agent.path, { recursive: true, force: true });
            }
            if (this.selection.red === agentId) { this.selection.red = ""; }
            if (this.selection.blue === agentId) { this.selection.blue = ""; }
            await this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage("Delete failed: " + err.message);
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
            label: a.name,
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

    /** Check no match is in progress. */
    private async checkNotRunning(): Promise<boolean> {
        if (this.isRunning) {
            vscode.window.showWarningMessage("A match is already running from this panel.");
            return false;
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
        for (const cmd of ["booster.virtualRobot.openSimulatorInAuxiliaryWindow", "booster.agent.run"]) {
            try { await vscode.commands.executeCommand(cmd); return; }
            catch { /* try next */ }
        }
        vscode.window.showInformationMessage("Click the robot icon in Booster Studio sidebar, then Run.");
    }

    async startVisualMatch(timeout = 0, lead = 0) {
        if (!(await this.checkNotRunning())) { return; }
        if (!this.selection.red || !this.selection.blue) {
            vscode.window.showWarningMessage("Select agents for both teams."); return;
        }
        this.isRunning = true;
        await this.resetEventTracking();
        const redName = this.agents.find((a) => a.id === this.selection.red)?.name || this.selection.red;
        const blueName = this.agents.find((a) => a.id === this.selection.blue)?.name || this.selection.blue;
        this.output.show();
        this.output.appendLine(`\n=== VISUAL: ${redName} vs ${blueName} ===\n`);
        try {
            this.postMessage({ type: "status_text", text: "Opening UI view (~60s)..." });
            try { await vscode.commands.executeCommand("booster.agent.run"); }
            catch (e: any) { this.output.appendLine("booster.agent.run: " + e.message); }
            const { team1Id, team2Id } = await this.deployAndClone();
            this.postMessage({ type: "status_text", text: "Starting runner..." });
            await this.restartRunnerWithTeams(team1Id, team2Id);
            this.postMessage({ type: "status_text", text: "Starting match!" });
            await apiStartMatch();
            this.postMessage({ type: "matchStarted", redName, blueName });
            await this.monitorMatch(apiEndMatch, timeout, lead);
            await this.autoSaveRecord(MODE_VISUAL);
        } catch (err: any) {
            this.output.appendLine("ERROR: " + err.message);
            vscode.window.showErrorMessage("Match failed: " + err.message);
        } finally {
            this.isRunning = false;
            this.postMessage({ type: "matchEnded" });
        }
    }

    async startMatch(count = 1, timeout = 0, lead = 0) {
        if (!(await this.checkNotRunning())) { return; }
        if (!this.selection.red || !this.selection.blue) {
            vscode.window.showWarningMessage("Select agents for both teams."); return;
        }
        const { team1Id, team2Id } = await this.deployAndClone();
        this.isRunning = true;
        this.output.show();
        this.output.appendLine(`\n=== HEADLESS x${count}: ${team1Id} vs ${team2Id} ===\n`);
        try {
            for (let i = 0; i < count; i++) {
                this.postMessage({ type: "batchProgress", current: i + 1, total: count });
                this.output.appendLine(`\n--- Match ${i + 1}/${count} ---`);
                await this.resetEventTracking();
                this.postMessage({ type: "matchStarted", redName: team1Id, blueName: team2Id });
                await this.restartRunnerWithTeams(team1Id, team2Id);
                await apiStartMatch();
                await this.monitorMatch(apiEndMatch, timeout, lead);
                await this.autoSaveRecord(MODE_HEADLESS);
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
            this.postMessage({ type: "matchEnded" });
        }
    }

    private async monitorMatch(endMatchFn: () => Promise<void>, timeoutSeconds = 0, leadGoals = 0) {
        const startTime = Date.now();
        let lastScore = "";
        while (this.isRunning) {
            const elapsed = (Date.now() - startTime) / 1000;
            if (timeoutSeconds > 0 && elapsed > timeoutSeconds) { await endMatchFn(); break; }
            let status: MatchStatus;
            try { status = await getMatchStatus(); }
            catch { await new Promise(r => setTimeout(r, 3000)); continue; }
            this.lastStatus = status;
            const sk = `${status.score.home}-${status.score.away}`;
            if (sk !== lastScore || status.isFinished) {
                this.output.appendLine(`[${elapsed.toFixed(0)}s] ${sk} | ${status.state} | ${status.durationSeconds.toFixed(0)}s`);
                lastScore = sk;
            }
            // NOTE: status + events UI updates are handled by pollOnce() (independent
            // timer started in resolveWebviewView), so they survive reload/reopen.
            // monitorMatch only owns auto-end logic here.
            if (status.isFinished) {
                this.output.appendLine(`\n=== FINISHED: ${sk} ===\n`);
                break;
            }
            if (leadGoals > 0 && Math.abs(status.score.home - status.score.away) >= leadGoals) { await endMatchFn(); break; }
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    async endMatch() {
        try { await apiEndMatch(); }
        catch { /* ignore */ }
    }

    async uploadAgentFile() {
        const projectsDir = vscode.workspace.getConfiguration("boosterMatch").get<string>("projectsDir", "");
        const uri = await vscode.window.showOpenDialog({
            canSelectMany: false, filters: { "Agent Package": ["agent"] },
            title: "Select .agent file",
            defaultUri: projectsDir ? vscode.Uri.file(projectsDir) : undefined,
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
                const choice = await vscode.window.showWarningMessage(
                    `Agent id '${meta.id}' already exists in the container.`,
                    "Use new id/name",
                    "Overwrite"
                );
                if (choice === undefined) { return; }
                if (choice === "Use new id/name") {
                    const newId = await vscode.window.showInputBox({
                        prompt: "Custom agent id (directory name). Leave as-is to overwrite.",
                        value: meta.id,
                        validateInput: (v) => {
                            const s = v.trim();
                            if (!s) { return undefined; } // empty = overwrite
                            // ROS2 node names are derived from the id (dots -> underscores)
                            // and only allow alphanumerics + '_'. A '-' in the id produces
                            // an invalid node name and the agent aborts at instantiate.
                            return /^[a-zA-Z][a-zA-Z0-9.]*$/.test(s)
                                ? undefined
                                : "Only letters, digits and dots are allowed (no '-', '_', spaces). Must start with a letter.";
                        },
                    });
                    if (newId === undefined) { return; }
                    const newName = await vscode.window.showInputBox({
                        prompt: "Custom display name for this agent.",
                        value: meta.name,
                    });
                    if (newName === undefined) { return; }
                    // Empty or unchanged id means overwrite → no override.
                    if (newId.trim() && newId.trim() !== meta.id) {
                        idOverride = newId.trim();
                    }
                    if (newName.trim() && newName.trim() !== meta.name) {
                        nameOverride = newName.trim();
                    }
                }
            }
            const id = await deployAgentFile(filePath, idOverride, nameOverride);
            vscode.window.showInformationMessage(`Deployed: ${id}`);
            await this.refresh();
        } catch (err: any) { vscode.window.showErrorMessage("Deploy failed: " + err.message); }
    }

    /** If the selected agent is a local .agent file, deploy it to the container
     *  first so run.py can find it under agent.json.id. Container agents are
     *  returned as-is. */
    private async ensureDeployed(agentId: string): Promise<string> {
        const agent = this.agents.find((a) => a.id === agentId);
        if (agent && agent.source === "file" && agent.path) {
            this.output.appendLine(`  Deploying local .agent file: ${agent.path}`);
            return await deployAgentFile(agent.path);
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
            await cloneAgent(team2Id, cloneId);
            team2Id = cloneId;
            await this.refresh();
        }
        return { team1Id, team2Id };
    }

    private async restartRunnerWithTeams(team1: string, team2: string): Promise<void> {
        this.saveCurrentTeams(team1, team2);
        this.output.appendLine("  Stopping old runner...");
        await dockerExec("pkill -9 -f football3v3; pkill -9 -f 'run.py.*teams'; pkill -9 -f pyagent_x86; sleep 2", 10000).catch(() => {});
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
            this.output.appendLine(`  Health ${i + 1}/15...`);
            try {
                const h = await gameControlApi("/health", "GET", 5000);
                if (h.ready === true && h.checks?.team1 === true && h.checks?.team2 === true) {
                    this.output.appendLine("  Ready!"); return;
                }
            } catch { /* wait */ }
        }
        throw new Error("Runner not ready in 75s.");
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
        const zipPath = path.join(this.recordsDir(), `match-${this.timestampName()}${scoreSuffix}.zip`);
        try {
            zip.writeZip(zipPath);
        } catch (err: any) {
            this.output.appendLine("  Auto-save failed: " + err.message);
            return;
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
    }

    /** Recover event tracking after reload/reopen: baseline = last match_started line,
     *  so we resume from the CURRENT match even if monitorMatch was interrupted. */
    private async recoverEventTracking(): Promise<void> {
        this.eventsLogPath = this.getEventsLogPath();
        this.finishEventAdded = false;
        const out = await dockerExec(
            `grep -n '"type":"match_started"' ${shellQuote(this.eventsLogPath)} | tail -1 | cut -d: -f1`,
            8000
        ).catch(() => "");
        const line = parseInt((out || "").trim(), 10);
        this.baseLineCount = Number.isFinite(line) && line > 0 ? line - 1 : 0;
        try {
            this.currentEvents = await readNewEvents(this.eventsLogPath, this.baseLineCount);
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
        this.postMessage({ type: "status", status });
        this.lastStatus = status;
        if (status.isFinished && !this.finishEventAdded) {
            this.finishEventAdded = true;
            this.appendFinishEvent(status);
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
<div class="tm"><span class="lab" id="lblEnd">End</span><span id="tEnd">—</span></div>
</div>
<div id="cwarn" class="cw" style="display:none"><span id="cwTxt">Container not running.</span><br><button class="btn" style="margin-top:6px" id="btnStartContainer" onclick="s('startContainer')">Start Container</button><div id="cwLoading" style="display:none;margin-top:8px"><span class="spin"></span> <span id="cwLoadingTxt">Starting container...</span></div></div>
<div class="section" id="ts"><div class="label" id="lblTeams">Teams</div>
<div class="tr"><div class="dot r"></div><select id="rsel" onchange="sel('red',this.value)"><option value="" id="optRed">Loading...</option></select></div>
<div class="tr"><div class="dot b"></div><select id="bsel" onchange="sel('blue',this.value)"><option value="" id="optBlue">Loading...</option></select></div></div>
<div class="section">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:11px;opacity:.7;width:3em" id="lblCount">Count</span><input id="count" type="number" min="1" max="999" value="1" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:12px"><span id="progress" style="font-size:11px;opacity:.7;min-width:34px;text-align:center"></span><button class="btn s" id="btnRecords" style="flex:0 0 auto;padding:5px 10px;font-size:13px" onclick="s('showRecords')" title="Match records">&#128203;</button></div>
<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-size:11px;opacity:.7;white-space:nowrap" id="lblTimeout">Match length(s)</span><input id="timeout" type="number" min="0" max="99999" value="0" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:12px"><span style="font-size:11px;opacity:.7;white-space:nowrap;margin-left:4px" id="lblLead">Lead goals</span><input id="lead" type="number" min="0" max="99" value="0" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:12px"></div>
<button class="btn" id="b1" onclick="sendStart('startVisual')">&#127944; <span id="t_b1">Start Match + UI</span></button>
<button class="btn s" id="b2" onclick="sendStart('startMatch')">&#9881; <span id="t_b2">Start Headless</span></button>
<div style="display:flex;gap:4px;margin-top:4px">
<button class="btn s" style="flex:1" onclick="s('openSim')">&#128064; <span id="t_openSim">UI</span></button>
<button class="btn s" style="flex:1" id="b3" onclick="s('endMatch')" disabled>&#9940; <span id="t_b3">End</span></button></div></div>
<div class="section"><div class="label" id="lblActions">Actions</div>
<div style="display:flex;gap:4px">
<button class="btn s icb" style="flex:1" onclick="s('refresh')" title="Refresh Agents"><span class="ic">&#8635;</span><span class="lb" id="t_refresh">Refresh</span></button>
<button class="btn s icb" style="flex:1" onclick="s('uploadAgent')" title="Upload Agent"><span class="ic">&#8682;</span><span class="lb" id="t_upload">Upload</span></button>
<button class="btn s icb" style="flex:1" onclick="s('saveLog')" title="Save Log"><span class="ic">&#128190;</span><span class="lb" id="t_save">Save</span></button>
<button class="btn s icb" style="flex:1" id="btnManageAgents" onclick="s('manageAgents')" title="Manage agents"><span class="ic">&#128203;</span><span class="lb" id="t_manageAgents">Manage</span></button>
</div></div>
<div class="section"><div class="label" id="lblKeyEvents">Key Events</div><div class="ev" id="evList"><div class="empty">No events yet</div></div></div>
<script>
const v=acquireVsCodeApi();
var panelState="idle";
var lastStatus=null,lastEvents=[];
var I18N={lang:"en",msg:{score:"Score",teams:"Teams",actions:"Actions",keyEvents:"Key Events",start:"Start",end:"End",count:"Count",records:"Match records",noEvents:"No events yet",starting:"Starting…",containerUnreachable:"Container unreachable",containerNotRunning:"Container not running.",startContainer:"Start Container",startMatchUi:"Start Match + UI",startHeadless:"Start Headless",ui:"UI",refresh:"Refresh",upload:"Upload",save:"Save",loading:"Loading...",noAgents:"No agents",timeout:"Match length(s)",lead:"Lead goals",preparing:"Preparing…",red:"Red",blue:"Blue",manageAgents:"Manage",startingContainer:"Starting container…"},states:{playing:"Playing",ready:"Ready",set:"Set",finished:"Finished"},events:{}};
function T(k){return I18N.msg[k]||k}
function humanize(ty){return ty.split("_").map(function(w){return w?w.charAt(0).toUpperCase()+w.slice(1):w}).join(" ")}
function evLabel(ty){return I18N.events[ty]||humanize(ty)}
function stateLabel(s){return I18N.states[s]||s}
function toggleLang(){v.postMessage({type:"toggleLang"})}
function s(t){v.postMessage({type:t})}
function sendStart(t){var c=parseInt(document.getElementById('count').value)||1;var to=parseInt(document.getElementById('timeout').value)||0;var ld=parseInt(document.getElementById('lead').value)||0;v.postMessage({type:t,count:c,timeout:to,lead:ld})}
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
  setText("lblCount",T("count"));
  setText("lblTimeout",T("timeout"));
  setText("lblLead",T("lead"));
  setText("cwTxt",T("containerNotRunning"));
  setText("btnStartContainer",T("startContainer"));
  setText("t_manageAgents",T("manageAgents"));
  setText("cwLoadingTxt",T("startingContainer"));
  setText("t_b1",T("startMatchUi"));
  setText("t_b2",T("startHeadless"));
  setText("t_openSim",T("ui"));
  setText("t_b3",T("end"));
  setText("t_refresh",T("refresh"));
  setText("t_upload",T("upload"));
  setText("t_save",T("save"));
  setText("optRed",T("loading"));
  setText("optBlue",T("loading"));
  document.getElementById("btnRecords").title=T("records");
  document.getElementById("langBtn").textContent=I18N.lang==="en"?"中":"EN";
  var sb=document.getElementById("settingsBtn");if(sb)sb.title=T("settings");
  rs(lastStatus);
  renderEvents(lastEvents);
}
window.addEventListener("message",function(e){var m=e.data;switch(m.type){
case"i18n":I18N=m.bundle;applyLang();break;
case"agents":ra(m.agents,m.selection,m.containerRunning);break;
case"status":lastStatus=m.status;rs(m.status);break;
case"matchReset":panelState="running";setScore(0,0);break;
case"status_text":{var el=document.getElementById("tEnd");if(el)el.textContent=m.text;break}
case"containerStarting":{var sb=document.getElementById("btnStartContainer"),ld=document.getElementById("cwLoading");if(m.starting){if(sb)sb.style.display="none";if(ld)ld.style.display="block";}else{if(sb)sb.style.display="";if(ld)ld.style.display="none";}break}
case"events":lastEvents=m.events;renderEvents(m.events);break;
case"batchProgress":{var pg=document.getElementById("progress");if(pg)pg.textContent=m.total>1?(m.current+"/"+m.total):"";break}
case"matchStarted":
  panelState="running";
  setScore(0,0);
  document.getElementById("tStart").textContent=T("starting");
  document.getElementById("tEnd").textContent=T("starting");
  d("b1",1);d("b2",1);d("b3",0);
  document.getElementById("rn").textContent=m.redName||"Red";
  document.getElementById("bn").textContent=m.blueName||"Blue";
  renderEvents([]);
  break;
case"matchActive":
  panelState="running";
  d("b1",1);d("b2",1);d("b3",0);
  break;
case"matchEnded":
  panelState="finished";
  d("b1",0);d("b2",0);d("b3",1);
  {var pg0=document.getElementById("progress");if(pg0)pg0.textContent="";}
  break;
}});
function d(id,dis){document.getElementById(id).disabled=dis}
function setScore(h,a){document.getElementById("rs").textContent=h;document.getElementById("bs").textContent=a}
function ra(a,sel,cr){
document.getElementById("cwarn").style.display=cr===false?"block":"none";
document.getElementById("ts").style.opacity=cr===false?".4":"1";
if(!a||!a.length){var na=T("noAgents");document.getElementById("rsel").innerHTML='<option value="">'+e(na)+'</option>';document.getElementById("bsel").innerHTML='<option value="">'+e(na)+'</option>';return;}
var o=a.map(function(x){return'<option value="'+e(x.id)+'">'+e(x.name)+" ("+x.source+" · "+e(x.id)+")</option>"}).join("");
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
if(st.isFinished){panelState="finished";d("b1",0);d("b2",0);d("b3",1);}
var updateScore=panelState!=="finished"||st.isFinished;
if(updateScore){setScore(st.score.home,st.score.away);}
document.getElementById("tStart").textContent=st.startedAtWallTime?fmtTime(st.startedAtWallTime,true):(active?T("preparing"):"—");
var endTxt;
if(st.endedAtWallTime){endTxt=fmtTime(st.endedAtWallTime,true);}
else if(st.isFinished){endTxt=stateLabel("finished");}
else if(active){endTxt=stateLabel("playing")+" · "+stateLabel(st.state);}
else{endTxt="—";}
document.getElementById("tEnd").textContent=endTxt;
}
function renderEvents(evs){
var el=document.getElementById("evList");
if(!evs||!evs.length){el.innerHTML='<div class="empty">'+T("noEvents")+'</div>';return;}
var homeName=document.getElementById("rn").textContent||T("red");
var awayName=document.getElementById("bn").textContent||T("blue");
var rows=evs.map(function(ev){
  var nm;
  if(ev.actorSide==="home"){nm='<span class="nm r">'+e(homeName)+" "+e(evLabel(ev.type))+"</span>";}
  else if(ev.actorSide==="away"){nm='<span class="nm b">'+e(awayName)+" "+e(evLabel(ev.type))+"</span>";}
  else{nm='<span class="nm">'+e(evLabel(ev.type))+"</span>";}
  return '<div class="row"><span class="ic">'+ev.icon+'</span><span class="t">'+fmtTime(ev.wallTime,false)+'</span>'+nm+'<span class="sc">'+ev.scoreHome+'-'+ev.scoreAway+'</span></div>';
}).join("");
el.innerHTML=rows;
}
function e(s){return String(s||"").replace(/[&<>"']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]})}
s("refresh")
</script></body></html>`;
    }
}