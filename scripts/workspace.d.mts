export const engineRoot: string;
export function selectedWorkspace(root?: string, env?: NodeJS.ProcessEnv): string;
export function initializeWorkspace(workspace: string, root?: string): string;
export function syncWorkspace(workspace: string, root?: string): void;
export function runInWorkspace(command: string, args: string[], root?: string): number;
