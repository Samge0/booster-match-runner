/**
 * Booster Match Runner extension entry point.
 *
 * Provides a sidebar panel for selecting two agents and running a match
 * with live score updates. Uses Docker CLI and the container's HTTP API.
 */

import * as vscode from "vscode";
import { MatchRunnerProvider } from "./matchRunnerProvider";
import { getMatchStatus } from "./matchRunner";

export function activate(context: vscode.ExtensionContext) {
    const provider = new MatchRunnerProvider(context);

    // Register the webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "boosterMatch.mainView",
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand("boosterMatch.refresh", async () => {
            await provider.refresh();
        }),

        vscode.commands.registerCommand("boosterMatch.startMatch", async () => {
            await provider.startMatch();
        }),

        vscode.commands.registerCommand("boosterMatch.startHeadless", async () => {
            await provider.startMatch();
        }),

        vscode.commands.registerCommand("boosterMatch.endMatch", async () => {
            await provider.endMatch();
        }),

        vscode.commands.registerCommand("boosterMatch.showStatus", async () => {
            const status = await getMatchStatus().catch(() => null);
            if (status) {
                vscode.window.showInformationMessage(
                    `Match: ${status.score.home}-${status.score.away} (${status.state}, ${status.durationSeconds.toFixed(0)}s)`
                );
            } else {
                vscode.window.showWarningMessage("Could not get match status. Is the container running?");
            }
        })
    );

    // Auto-refresh agents on activation
    provider.refresh();
}

export function deactivate() {}
