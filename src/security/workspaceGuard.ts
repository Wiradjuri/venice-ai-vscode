import * as vscode from 'vscode';

/** Whether Venice is allowed to make any network call in the current workspace. */
export function isVeniceEnabled(): boolean {
  return vscode.workspace.getConfiguration('venice').get<boolean>('enabled', true);
}

export async function setVeniceEnabled(enabled: boolean): Promise<void> {
  // Workspace-scoped (not WorkspaceFolder) so the toggle applies to the whole open workspace
  // without requiring a specific folder resource, and doesn't leak into User settings.
  await vscode.workspace.getConfiguration('venice').update('enabled', enabled, vscode.ConfigurationTarget.Workspace);
}

export async function toggleVeniceEnabled(): Promise<boolean> {
  const next = !isVeniceEnabled();
  await setVeniceEnabled(next);
  return next;
}
