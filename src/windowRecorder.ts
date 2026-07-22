/**
 * Record the Booster Studio window to an MP4, cross-platform.
 *
 * The viewer (3D scene + score HUD + robot skins) lives inside the Studio main
 * window, so cropping a desktop capture to that window records exactly what the
 * user sees — no offline re-render. UI-mode only.
 *
 * Per platform:
 *   win32   PowerShell (window_rect.ps1, GetWindowRect) + `ffmpeg -f gdigrab -i desktop`
 *   linux   bash (window_rect.sh, wmctrl + xdpyinfo)    + `ffmpeg -f x11grab -i :0.0+X,Y`
 *   darwin  osascript (System Events)                   + `ffmpeg -f avfoundation -i "<screen>:"` + crop
 *
 * All three capture the visible screen, so the window must stay foreground &
 * unobstructed (minimized/covered windows record blank). Requires ffmpeg on the
 * host PATH (plus wmctrl/x11-utils on Linux; Accessibility permission on macOS).
 */

import * as cp from "child_process";

export class WindowRecorder {
    private child: cp.ChildProcess | null = null;

    constructor(private rectScriptWin: string, private rectScriptLinux: string) {}

    /** Run a command and return trimmed stdout ("" on failure/timeout). */
    private run(cmd: string[], timeout = 8000): Promise<string> {
        return new Promise((resolve) => {
            cp.execFile(cmd[0], cmd.slice(1), { timeout, maxBuffer: 1024 }, (err, stdout) => {
                resolve(err ? "" : stdout.toString().trim());
            });
        });
    }

    /** Resolve the clamped window rect ("X Y W H") for the current platform. */
    private async resolveRect(): Promise<string | null> {
        const p = process.platform;
        if (p === "win32") {
            return (await this.run([
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.rectScriptWin,
            ])) || null;
        }
        if (p === "linux") {
            return (await this.run(["bash", this.rectScriptLinux])) || null;
        }
        if (p === "darwin") {
            // System Events: position + size of the Booster Studio front window.
            const scr = `
tell application "System Events"
    set p to first process whose name contains "Booster Studio"
    set pos to position of window 1 of p
    set sz to size of window 1 of p
    return (item 1 of pos as text) & " " & (item 2 of pos as text) & " " & (item 1 of sz as text) & " " & (item 2 of sz as text)
end tell`;
            return (await this.run(["osascript", "-e", scr], 8000)) || null;
        }
        return null;
    }

    /** Build the ffmpeg argv for the current platform to capture rect → outMp4. */
    private ffmpegArgs(x: string, y: string, w: string, h: string, outMp4: string): string[] {
        const p = process.platform;
        const head = ["-hide_banner", "-loglevel", "error", "-framerate", "20"];
        const tail = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-movflags", "+faststart", outMp4];
        if (p === "win32") {
            return [...head, "-f", "gdigrab", "-offset_x", x, "-offset_y", y, "-video_size", `${w}x${h}`, "-i", "desktop", ...tail];
        }
        if (p === "linux") {
            // The X server isn't always :0 — gdm/Ubuntu sessions often get :1.
            // Read $DISPLAY (inherited by the extension host) instead of hardcoding.
            const disp = process.env.DISPLAY || ":0.0";
            return [...head, "-f", "x11grab", "-video_size", `${w}x${h}`, "-i", `${disp}+${x},${y}`, ...tail];
        }
        if (p === "darwin") {
            // avfoundation has no offset input → capture a screen and crop to the rect.
            // "1:" = video device index 1 (often the main display), no audio. If you get
            // the wrong/black screen, list devices with:
            //   ffmpeg -f avfoundation -list_devices true -i ""
            // and adjust the index here.
            return [...head, "-f", "avfoundation", "-i", "1:", "-vf", `crop=${w}:${h}:${x}:${y}`, ...tail];
        }
        return [];
    }

    /** Start recording to outMp4. Returns true if ffmpeg came up & stayed up. */
    async start(outMp4: string): Promise<boolean> {
        const rect = await this.resolveRect();
        if (!rect) { return false; }
        const parts = rect.split(/\s+/);
        if (parts.length < 4) { return false; }
        const [x, y, w, h] = parts;
        const args = this.ffmpegArgs(x, y, w, h, outMp4);
        if (!args.length) { return false; }
        this.child = cp.spawn("ffmpeg", args, { windowsHide: true });
        return new Promise((resolve) => {
            const c = this.child;
            if (!c) { resolve(false); return; }
            // ffmpeg keeps running once capturing; if it exits within ~1.2s it failed
            const t = setTimeout(() => resolve(this.child !== null), 1200);
            c.on("error", () => { clearTimeout(t); this.child = null; resolve(false); });
            c.on("exit", () => { clearTimeout(t); this.child = null; resolve(false); });
        });
    }

    /** Stop recording gracefully so ffmpeg flushes the mp4. */
    async stop(): Promise<boolean> {
        const c = this.child;
        this.child = null;
        if (!c) { return false; }
        try { c.stdin?.write("q"); } catch { /* ignore */ }
        return new Promise((resolve) => {
            const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* ignore */ } resolve(false); }, 4000);
            c.on("exit", () => { clearTimeout(t); resolve(true); });
        });
    }
}
