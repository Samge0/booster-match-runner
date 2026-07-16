/**
 * Agent discovery: find agents in the container and on the host.
 */

import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { dockerExec } from "./docker";
import { AgentInfo } from "./types";
import AdmZip from "adm-zip";

const CONTAINER_AGENT_ROOT = "/opt/booster/booster_agent_data/data/agents/extract";

/** Agent ids hidden from the picker: empty + system placeholders not meant to
 *  be picked as a team. com.boosterobotics.default is a built-in demo agent
 *  (loads fine, Inactive=>Active, but doesn't play soccer — picking it leaves
 *  robots standing still). The referee is a separate process, not an agent. */
const BLOCKED_AGENT_IDS = new Set<string>(["com.boosterobotics.default"]);

/** Discover all agents available in the container's extract directory. */
export async function discoverContainerAgents(): Promise<AgentInfo[]> {
    try {
        const stdout = await dockerExec(
            `ls ${CONTAINER_AGENT_ROOT} 2>/dev/null`,
            5000
        );
        const dirs = stdout.trim().split("\n").filter(Boolean);
        const agents: AgentInfo[] = [];
        for (const dir of dirs) {
            const id = dir.trim();
            if (!id) continue;
            const meta = await readContainerAgentMeta(id);
            agents.push({
                id,
                name: meta.name,
                source: "container",
                path: `${CONTAINER_AGENT_ROOT}/${id}`,
                version: meta.version,
            });
        }
        return agents;
    } catch {
        return [];
    }
}

/** Read an agent's display name + version from its agent.json inside the
 *  container. Falls back to the id (directory name) if agent.json is unreadable. */
async function readContainerAgentMeta(id: string): Promise<{ name: string; version: string }> {
    try {
        const out = await dockerExec(`cat ${CONTAINER_AGENT_ROOT}/${id}/agent.json 2>/dev/null`, 5000);
        const parsed = JSON.parse(out.trim());
        const name = parsed.name?.en || parsed.name || id;
        const version = typeof parsed.version === "string" ? parsed.version : "";
        return { name, version };
    } catch {
        return { name: id, version: "" };
    }
}

/** True if an agent with this id is already deployed in the container. */
export async function containerAgentExists(id: string): Promise<boolean> {
    try {
        const s = await dockerExec(`test -d ${CONTAINER_AGENT_ROOT}/${id} && echo yes`, 5000);
        return s.trim() === "yes";
    } catch {
        return false;
    }
}

/** Read id/name/version from a .agent (ZIP) file's agent.json. The id MUST come
 *  from agent.json — it is the extract directory name that deployAgentFile uses,
 *  so the UI id has to match or run.py cannot find the agent. Falls back to the
 *  filename (minus extension) only if agent.json is unreadable. */
export function readAgentFileMeta(agentFile: string): { id: string; name: string; version: string } {
    const fallbackId = path.basename(agentFile, ".agent");
    let id = fallbackId;
    let name = fallbackId;
    let version = "";
    try {
        const zip = new AdmZip(agentFile);
        const entry = zip.getEntry("agent.json");
        if (entry) {
            const parsed = JSON.parse(zip.readAsText(entry));
            id = parsed.id || id;
            name = parsed.name?.en || parsed.id || name;
            version = parsed.version || "";
        }
    } catch {
        // fall back to filename
    }
    return { id, name, version };
}

/** Build an AgentInfo from a host .agent file. */
function makeAgentFromFile(agentFile: string): AgentInfo {
    const meta = readAgentFileMeta(agentFile);
    return { id: meta.id, name: meta.name, source: "file", path: agentFile, version: meta.version };
}

/** Discover .agent files under the configured hostAgentRoots.
 *  Scans one level into each root (project folders) plus .agent files sitting
 *  directly in the root. Roots are user-configured; empty by default. */
export async function discoverHostAgentFiles(): Promise<AgentInfo[]> {
    const roots = vscode.workspace.getConfiguration("boosterMatch").get<string[]>("hostAgentRoots", []).filter(Boolean);

    const agents: AgentInfo[] = [];
    for (const root of roots) {
        let entries: string[];
        try { entries = fs.readdirSync(root); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(root, entry);
            let isDir = false;
            try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
            if (isDir) {
                let subEntries: string[];
                try { subEntries = fs.readdirSync(full); } catch { continue; }
                for (const sub of subEntries) {
                    if (sub.endsWith(".agent")) {
                        agents.push(makeAgentFromFile(path.join(full, sub)));
                    }
                }
            } else if (entry.endsWith(".agent")) {
                agents.push(makeAgentFromFile(full));
            }
        }
    }
    return agents;
}

/** Get all available agents (container + host), hiding known-invalid placeholders. */
export async function getAllAgents(): Promise<AgentInfo[]> {
    const [container, host] = await Promise.all([
        discoverContainerAgents(),
        discoverHostAgentFiles(),
    ]);
    return [...container, ...host].filter((a) => !BLOCKED_AGENT_IDS.has(a.id));
}
