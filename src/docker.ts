/**
 * Docker helper: all container operations go through here.
 * Uses child_process to call docker CLI (no Docker SDK dependency).
 */

import * as cp from "child_process";
import * as vscode from "vscode";

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("boosterMatch");
}

/** Cached auto-detected container name (cleared only on process restart). */
let cachedContainerName = "";

/** Run `docker <args>` and return stdout. */
function runDocker(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err) { reject(err); } else { resolve(stdout); }
        });
    });
}

/** Resolve the sim container: explicit config > auto-detected by sim image > empty.
 *  Auto-detection runs `docker ps --filter ancestor=<simImage>` and caches the
 *  first match so repeated operations don't re-query Docker. */
async function resolveContainer(): Promise<string> {
    const configured = getConfig().get<string>("containerName", "");
    if (configured) { return configured; }
    if (cachedContainerName) { return cachedContainerName; }
    try {
        const simImage = getConfig().get<string>("simImage", "");
        if (!simImage) { return ""; }
        const out = await runDocker(["ps", "-a", "--format", "{{.Names}}", "--filter", `ancestor=${simImage}`], 10000);
        const name = out.split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
        if (name) { cachedContainerName = name; }
        return name;
    } catch {
        return "";
    }
}

/** Throw a clear error if no container could be resolved. */
async function requireContainer(): Promise<string> {
    const name = await resolveContainer();
    if (!name) {
        throw new Error("Could not resolve sim container. Set boosterMatch.containerName or run the virtual-robot container.");
    }
    return name;
}

/** Quick check: is a specific container running? Never throws. */
function checkRunning(name: string): Promise<boolean> {
    return new Promise((resolve) => {
        cp.execFile("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeout: 5000 }, (err, stdout) => {
            resolve(!err && stdout.trim() === "true");
        });
    });
}

/** Run a docker exec command and return stdout. */
export async function dockerExec(cmd: string, timeoutMs = 15000): Promise<string> {
    const container = await requireContainer();
    const full = ["exec", container, "bash", "-c", cmd];
    return new Promise((resolve, reject) => {
        cp.execFile("docker", full, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`${err.message}\n${stderr}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

/** Run docker exec in background (detached). */
export async function dockerExecDetached(cmd: string): Promise<void> {
    const container = await requireContainer();
    const full = ["exec", "-d", container, "bash", "-c", cmd];
    return new Promise((resolve, reject) => {
        cp.execFile("docker", full, { timeout: 10000 }, (err) => {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

/** Copy a file from host to container. */
export async function dockerCpTo(src: string, dst: string): Promise<void> {
    const container = await requireContainer();
    const full = ["cp", src, `${container}:${dst}`];
    return new Promise((resolve, reject) => {
        cp.execFile("docker", full, { timeout: 30000 }, (err) => {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

/** Check if the simulation container is running. */
export async function isContainerRunning(): Promise<boolean> {
    const name = await resolveContainer();
    if (!name) { return false; }
    return checkRunning(name);
}

/** Start the resolved sim container. Returns its name, or "" if none found. */
export async function startSimContainer(): Promise<string> {
    const name = await resolveContainer();
    if (!name) { return ""; }
    await runDocker(["start", name], 30000);
    return name;
}

/** HTTP request to the game control API inside the container (via docker exec curl). */
export async function gameControlApi(path: string, method = "GET", timeoutMs = 5000): Promise<any> {
    const port = getConfig().get<number>("gameControlPort", 38383);
    const cmd = `curl -s --max-time ${Math.floor(timeoutMs / 1000)} -X ${method} http://127.0.0.1:${port}${path}`;
    const stdout = await dockerExec(cmd, timeoutMs + 2000);
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error(`Empty response from ${path}`);
    }
    return JSON.parse(trimmed);
}

/**
 * Clone an agent in the container with a different ID (e.g. com.samge.agent -> com.samge.agent.blue).
 * This is needed when both teams use the same agent and ROS2 package names would conflict.
 *
 * Steps:
 * 1. Copy the extract dir
 * 2. Update agent.json id + ros2.package_name
 * 3. Rename internal dirs to match new package_name
 * 4. Update package.xml and launch.py
 */
export async function cloneAgent(sourceId: string, cloneId: string): Promise<void> {
    const extractRoot = "/opt/booster/booster_agent_data/data/agents/extract";
    const srcDir = `${extractRoot}/${sourceId}`;
    const dstDir = `${extractRoot}/${cloneId}`;

    // Check if clone already exists
    const exists = await dockerExec(`test -d ${dstDir} && echo yes || echo no`, 5000);
    if (exists.trim() === "yes") {
        // Remove old clone
        await dockerExec(`rm -rf ${dstDir}`, 10000);
    }

    // Step 1: Copy the directory
    await dockerExec(`cp -a ${srcDir} ${dstDir}`, 30000);

    // Step 2: Read original agent.json to get the original package_name
    const origJson = await dockerExec(`cat ${srcDir}/agent.json`, 5000);
    const orig = JSON.parse(origJson.trim());
    const origPkg = orig.ros2?.package_name || `${sourceId.replace(/\./g, "_")}`;
    const clonePkg = `${cloneId.replace(/\./g, "_")}`;

    // Step 3: Update agent.json (write script via base64 to avoid shell escaping)
    const cloneLines = [
        "import json",
        `p = r"${dstDir}/agent.json"`,
        "d = json.load(open(p))",
        `d["id"] = "${cloneId}"`,
        `d["ros2"]["package_name"] = "${clonePkg}"`,
        "json.dump(d, open(p, 'w'), indent=4)",
        'print("agent.json updated")',
    ];
    const cloneB64 = Buffer.from(cloneLines.join("\n") + "\n").toString("base64");
    await dockerExec(`echo ${cloneB64} | base64 -d > /tmp/_clone.py && python3 /tmp/_clone.py`, 10000);

    // Step 4: Rename internal package dirs
    // Structure: dstDir/agent/<pkg>/lib/<pkg>/  and  dstDir/agent/<pkg>/share/<pkg>/
    const oldAgentDir = `${dstDir}/agent/${origPkg}`;
    const newAgentDir = `${dstDir}/agent/${clonePkg}`;
    await dockerExec(`if [ -d "${oldAgentDir}" ]; then mv "${oldAgentDir}" "${newAgentDir}"; fi`, 5000);

    // Rename lib/<old> -> lib/<new>
    await dockerExec(`if [ -d "${newAgentDir}/lib/${origPkg}" ]; then mv "${newAgentDir}/lib/${origPkg}" "${newAgentDir}/lib/${clonePkg}"; fi`, 5000);

    // Rename share/<old> -> share/<new>
    await dockerExec(`if [ -d "${newAgentDir}/share/${origPkg}" ]; then mv "${newAgentDir}/share/${origPkg}" "${newAgentDir}/share/${clonePkg}"; fi`, 5000);

    // Update package.xml
    await dockerExec(
        `find ${newAgentDir}/share -name "package.xml" -exec sed -i 's|<name>${origPkg}</name>|<name>${clonePkg}</name>|g' {} + 2>/dev/null`,
        5000
    ).catch(() => {});

    // Update launch.py
    await dockerExec(
        `find ${newAgentDir}/share -name "launch.py" -exec sed -i "s|package='${origPkg}'|package='${clonePkg}'|g" {} + 2>/dev/null`,
        5000
    ).catch(() => {});

    // Rename ament_index resource
    await dockerExec(
        `find ${newAgentDir}/share/ament_index -name "${origPkg}" -exec mv {} ${newAgentDir}/share/ament_index/resource_index/packages/${clonePkg} 2>/dev/null \;`,
        5000
    ).catch(() => {});

    // Rename colcon-core packages
    await dockerExec(
        `find ${newAgentDir}/share/colcon-core -name "${origPkg}*" -exec bash -c 'mv "$0" "$(dirname $0)/${clonePkg}"' {} \; 2>/dev/null`,
        5000
    ).catch(() => {});
}

/**
 * Deploy a .agent file (ZIP package) to the container's extract directory.
 * Extracts it and returns the agent ID.
 */
export async function deployAgentFile(
    hostPath: string,
    agentIdOverride?: string
): Promise<string> {
    const extractRoot = "/opt/booster/booster_agent_data/data/agents/extract";
    const containerTmp = "/tmp/uploaded_agent.agent";

    // Copy .agent file to container
    await dockerCpTo(hostPath.replace(/\//g, "/"), containerTmp);

    // Extract it to a temp dir to read agent.json
    const tmpExtract = "/tmp/uploaded_agent_extract";
    await dockerExec(`rm -rf ${tmpExtract} && mkdir -p ${tmpExtract}`, 5000);
    // Use python3 zipfile (unzip not installed in container).
    // Write extraction script via base64 to avoid shell escaping issues.
    const extractLines = [
        "import zipfile",
        `z = zipfile.ZipFile(r"${containerTmp}")`,
        `z.extractall(r"${tmpExtract}")`,
        "z.close()",
        'print("extracted")',
    ];
    const extractB64 = Buffer.from(extractLines.join("\n") + "\n").toString("base64");
    await dockerExec(`echo ${extractB64} | base64 -d > /tmp/_extract.py && python3 /tmp/_extract.py`, 30000);

    // Read agent.json
    const jsonOut = await dockerExec(`cat ${tmpExtract}/agent.json 2>/dev/null`, 5000);
    const agentJson = JSON.parse(jsonOut.trim());
    const agentId = agentIdOverride || agentJson.id;
    const targetDir = `${extractRoot}/${agentId}`;

    // Remove existing
    await dockerExec(`rm -rf ${targetDir}`, 10000);

    // The .agent ZIP has: agent.json, agent/ (ros2 package), res/, resources/, libs/
    // We need to place it correctly in the extract dir
    // Extract dir structure: <agentId>/agent.json + <agentId>/agent/<ros2pkg>/...
    await dockerExec(`mkdir -p ${targetDir}`, 5000);
    await dockerExec(`cp ${tmpExtract}/agent.json ${targetDir}/agent.json`, 5000);

    // Copy the agent dir (contains the ROS2 package)
    if (await dockerExec(`test -d ${tmpExtract}/agent && echo yes`, 5000).then(s => s.trim() === "yes")) {
        await dockerExec(`cp -a ${tmpExtract}/agent ${targetDir}/agent`, 30000);
    }

    // Copy other dirs
    for (const d of ["res", "resources", "libs"]) {
        await dockerExec(`test -d ${tmpExtract}/${d} && cp -a ${tmpExtract}/${d} ${targetDir}/${d} 2>/dev/null; true`, 5000);
    }

    // Clean up
    await dockerExec(`rm -rf ${tmpExtract} ${containerTmp}`, 5000);

    return agentId;
}
