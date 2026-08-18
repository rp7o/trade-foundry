export interface ResultArtifact {
  primary: {
    name: string;
    value: number;
  };
  checks?: Array<{
    name: string;
    passed: boolean;
    value?: number | string | boolean;
    threshold?: number | string | boolean;
  }>;
  secondary?: Array<{
    name: string;
    value: number;
  }>;
  segments?: Array<{
    name: string;
    group?: string;
    score?: number;
    value?: number;
    passed?: boolean;
  }>;
  diagnostics?: unknown;
}

export interface Config {
  hooks: {
    workflow: string;
  };
  commands: {
    setup: string;
    experiment: string;
    candidateChecks: string[];
    prepareCandidate?: string;
    preLoop?: string;
  };
  metric: {
    name: string;
    regex: string;
    artifactPath?: string;
  };
  acceptance: {
    minDeltaPct: number;
  };
  scope: {
    editable: string[];
    persistent: string[];
    frozen: string[];
  };
  budget: {
    timeoutSeconds: number;
  };
  git: {
    enabled: boolean;
    autoRevertRejected: boolean;
  };
  agent?: {
    command: string;
    timeoutSeconds: number;
  };
  loop: {
    maxIterations: number;
    maxNonImprovingRuns: number;
  };
  accepted: {
    preserve: string[];
  };
}

export interface BestResult {
  timestamp: string;
  command: string;
  metricName: string;
  score: number;
  logFile: string;
  artifactFile?: string;
}

export interface RunRecord {
  timestamp: string;
  command: string;
  metricName: string;
  score: number;
  bestBefore: number;
  accepted: boolean;
  durationMs: number;
  changedFiles: string[];
  logFile: string;
  artifactFile?: string;
  contextId?: string;
  acceptanceReason?: string;
}

export interface AgentAttemptRecord {
  timestamp: string;
  agentCommand: string;
  agentTimedOut: boolean;
  agentExitCode: number | null;
  agentDurationMs: number;
  changedFiles: string[];
  outcome: "accepted" | "rejected" | "no-change" | "scope-violation" | "agent-error" | "validation-error" | "eval-error";
  restored: boolean;
  runRecord?: string;
  error?: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}
