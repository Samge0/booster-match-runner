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

/** Fallback image substring when simImage is unset / does not match anything.
 *  Matches any version of the Booster virtual-robot sim image. */
const VIRTUAL_ROBOT_IMAGE = "virtual-robot/virtual-robot";

/** Run `docker <args>` and return stdout. */
function runDocker(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err) { reject(err); } else { resolve(stdout); }
        });
    });
}

/** Resolve the sim container: explicit config > auto-detected by sim image > empty.
 *  Auto-detection lists all containers (image + name + state), prefers running
 *  ones, then matches by the configured simImage (substring, tag-agnostic) and
 *  falls back to VIRTUAL_ROBOT_IMAGE. First match is cached so repeated
 *  operations don't re-query Docker. */
async function resolveContainer(): Promise<string> {
    const configured = getConfig().get<string>("containerName", "");
    if (configured) { return configured; }
    if (cachedContainerName) { return cachedContainerName; }
    try {
        const out = await runDocker(["ps", "-a", "--format", "{{.Image}}\t{{.Names}}\t{{.State}}"], 10000);
        const rows = out.split("\n")
            .map(s => s.trim())
            .filter(Boolean)
            .map(line => {
                const [image, name, state] = line.split("\t");
                return { image: image || "", name: name || "", running: (state || "").toLowerCase() === "running" };
            });
        if (!rows.length) { return ""; }
        // Running containers first so a live sim wins over a stopped one.
        rows.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));
        const simImage = getConfig().get<string>("simImage", "").trim();
        const matchBy = (needle: string) => rows.find(r => r.image.includes(needle));
        const hit = (simImage ? matchBy(simImage) : undefined) || matchBy(VIRTUAL_ROBOT_IMAGE);
        const name = hit?.name || "";
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

/** Convert an agent id to a valid ROS2 package name: lowercase, every run of
 *  non-[a-z0-9] characters becomes a single underscore, trimmed. ROS2 package
 *  names must match [a-z][a-z0-9_]*, so an id like "com.samge.agent.3-2"
 *  becomes "com_samge_agent_3_2". */
function ros2PkgName(id: string): string {
    const pkg = id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return pkg || "agent";
}

/** Rewrite a deployed agent directory so its whole identity — agent.json id,
 *  ros2.package_name, and the ROS2 package layout (agent/<pkg>, lib, share,
 *  package.xml, launch.py, ament_index, colcon-core) — reflects newId.
 *
 *  Without this, deploying the SAME .agent under a second id yields two copies
 *  that share one ROS2 package name; the second team's pyagent can't start
 *  (package/node collision) and those robots never move. Used both by cloneAgent
 *  and by deployAgentFile's custom-id path. */
async function renameAgentIdentity(agentDir: string, newId: string): Promise<void> {
    const jsonOut = await dockerExec(`cat ${agentDir}/agent.json`, 5000);
    const orig = JSON.parse(jsonOut.trim());
    const origPkg = orig.ros2?.package_name || ros2PkgName(orig.id || newId);
    const newPkg = ros2PkgName(newId);
    if (origPkg === newPkg && orig.id === newId) { return; }

    // Update agent.json id + ros2.package_name (base64 script, avoids escaping).
    const lines = [
        "import json",
        `p = r"${agentDir}/agent.json"`,
        "d = json.load(open(p))",
        `d["id"] = "${newId}"`,
        `if d.get("ros2"): d["ros2"]["package_name"] = "${newPkg}"`,
        "json.dump(d, open(p, 'w'), indent=4)",
        'print("agent.json updated")',
    ];
    const b64 = Buffer.from(lines.join("\n") + "\n").toString("base64");
    await dockerExec(`echo ${b64} | base64 -d > /tmp/_rename.py && python3 /tmp/_rename.py`, 10000);

    // Rename internal package dirs: agentDir/agent/<pkg>/{lib,share}/<pkg>
    const oldPkgDir = `${agentDir}/agent/${origPkg}`;
    const newPkgDir = `${agentDir}/agent/${newPkg}`;
    await dockerExec(`if [ -d "${oldPkgDir}" ]; then mv "${oldPkgDir}" "${newPkgDir}"; fi`, 5000);
    await dockerExec(`if [ -d "${newPkgDir}/lib/${origPkg}" ]; then mv "${newPkgDir}/lib/${origPkg}" "${newPkgDir}/lib/${newPkg}"; fi`, 5000);
    await dockerExec(`if [ -d "${newPkgDir}/share/${origPkg}" ]; then mv "${newPkgDir}/share/${origPkg}" "${newPkgDir}/share/${newPkg}"; fi`, 5000);

    // Update package.xml
    await dockerExec(
        `find ${newPkgDir}/share -name "package.xml" -exec sed -i 's|<name>${origPkg}</name>|<name>${newPkg}</name>|g' {} + 2>/dev/null`,
        5000
    ).catch(() => {});
    // Update launch.py
    await dockerExec(
        `find ${newPkgDir}/share -name "launch.py" -exec sed -i "s|package='${origPkg}'|package='${newPkg}'|g" {} + 2>/dev/null`,
        5000
    ).catch(() => {});
    // Rename ament_index resource marker. Path is fixed at
    // share/ament_index/resource_index/packages/<pkg>, so a direct mv is enough
    // (a previous `find -exec mv ... 2>/dev/null \;` was buggy: the redirect,
    // sitting before `\;`, was passed to mv as a literal arg and the marker was
    // never renamed → ROS2 launch "Package not found").
    await dockerExec(
        `mv ${newPkgDir}/share/ament_index/resource_index/packages/${origPkg} ${newPkgDir}/share/ament_index/resource_index/packages/${newPkg} 2>/dev/null; true`,
        5000
    ).catch(() => {});
    // Rename colcon-core packages
    await dockerExec(
        `find ${newPkgDir}/share/colcon-core -name "${origPkg}*" -exec bash -c 'mv "$0" "$(dirname $0)/${newPkg}"' {} \; 2>/dev/null`,
        5000
    ).catch(() => {});

    // Rename the Python package under site-packages. pyagent loads its pymod
    // from lib/python*/site-packages/<package_name>; if we leave the original
    // dir name it aborts with "Pymod dir not exist". Also rename the
    // egg-info/dist-info dir and fix top_level.txt. (Safe because Booster
    // agents use relative imports — verified no absolute imports of the pkg.)
    const spLines = [
        "import os, glob",
        `origPkg = r"${origPkg}"`,
        `newPkg = r"${newPkg}"`,
        `for sp in glob.glob(r"${newPkgDir}/lib/python*/site-packages"):`,
        "    src = os.path.join(sp, origPkg)",
        "    if os.path.exists(src): os.rename(src, os.path.join(sp, newPkg))",
        "    for old in glob.glob(os.path.join(sp, origPkg + '-*')):",
        "        base = os.path.basename(old)",
        "        os.rename(old, os.path.join(sp, newPkg + base[len(origPkg):]))",
        "    for info in glob.glob(os.path.join(sp, newPkg + '-*.egg-info')) + glob.glob(os.path.join(sp, newPkg + '-*.dist-info')):",
        "        tl = os.path.join(info, 'top_level.txt')",
        "        if os.path.exists(tl):",
        "            with open(tl) as f: c = f.read()",
        "            with open(tl, 'w') as f: f.write(c.replace(origPkg, newPkg))",
        "print('site-packages renamed')",
    ];
    const spB64 = Buffer.from(spLines.join("\n") + "\n").toString("base64");
    await dockerExec(`echo ${spB64} | base64 -d > /tmp/_sp.py && python3 /tmp/_sp.py`, 10000).catch(() => {});
}

/**
 * Clone an agent in the container with a different ID (e.g. com.samge.agent -> com.samge.agent.blue).
 * Needed when both teams use the same agent and ROS2 package names would conflict.
 */
export async function cloneAgent(sourceId: string, cloneId: string): Promise<void> {
    const extractRoot = "/opt/booster/booster_agent_data/data/agents/extract";
    const srcDir = `${extractRoot}/${sourceId}`;
    const dstDir = `${extractRoot}/${cloneId}`;

    const exists = await dockerExec(`test -d ${dstDir} && echo yes || echo no`, 5000);
    if (exists.trim() === "yes") {
        await dockerExec(`rm -rf ${dstDir}`, 10000);
    }
    await dockerExec(`cp -a ${srcDir} ${dstDir}`, 30000);
    await renameAgentIdentity(dstDir, cloneId);
}

/**
 * Deploy a .agent file (ZIP package) to the container's extract directory.
 * Extracts it and returns the agent ID.
 */
export async function deployAgentFile(
    hostPath: string,
    agentIdOverride?: string,
    nameOverride?: string
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

    // Restore executable bits. python zipfile.extractall() does NOT apply the
    // unix mode stored in the zip, so pyagent_x86_64 / *.so end up non-executable
    // (mode 0644) and ROS2 launch aborts with "executable 'pyagent_x86_64' not
    // found on the libexec directory". chmod the agent binaries + shared libs.
    await dockerExec(
        `find ${targetDir} -type f \\( -name 'pyagent*' -o -name '*.so*' \\) -exec chmod +x {} + 2>/dev/null; true`,
        10000
    );

    // When deploying under a custom id, rewrite the agent's whole identity
    // (agent.json id + ros2.package_name + ROS2 package layout) so it becomes a
    // truly independent agent. Otherwise two copies of the same .agent share one
    // ROS2 package name and the second team's pyagent can't start.
    if (agentIdOverride && agentIdOverride !== agentJson.id) {
        await renameAgentIdentity(targetDir, agentIdOverride);
    }

    // Override display name in agent.json if requested. Name may be a string
    // or a LocaleString object ({en, zh, ...}); we set the .en field when it's
    // an object, else replace the string. Name is passed base64-encoded to
    // avoid shell/quote escaping issues.
    if (nameOverride) {
        const b64Name = Buffer.from(nameOverride, "utf-8").toString("base64");
        const nameLines = [
            "import json, base64",
            `p = r"${targetDir}/agent.json"`,
            "d = json.load(open(p, encoding='utf-8'))",
            `val = base64.b64decode("${b64Name}").decode('utf-8')`,
            "nm = d.get('name')",
            "if isinstance(nm, dict): nm['en'] = val",
            "else: d['name'] = val",
            "json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False)",
            "print('name-set')",
        ];
        const nameB64 = Buffer.from(nameLines.join("\n") + "\n").toString("base64");
        await dockerExec(`echo ${nameB64} | base64 -d > /tmp/_setname.py && python3 /tmp/_setname.py`, 10000);
    }

    // Clean up
    await dockerExec(`rm -rf ${tmpExtract} ${containerTmp}`, 5000);

    return agentId;
}
