#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ExitCode,
  type ProtocolEvent,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";
import { Octokit } from "@octokit/rest";

const agentName = "issue-reader";
const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "issue.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `issue-reader only supports issue.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "issue-reader started", {
    agentVersion,
  });

  const issue = await readIssue(task.value);
  if (!issue.ok) {
    emit(task.value, "agent.failed", "error", issue.message, {
      error: {
        code: issue.code,
        message: issue.message,
      },
    });
    return issue.exitCode;
  }

  const summary = issue.value;

  emit(task.value, "agent.output", "info", "Issue parsed", summary as ProtocolEvent["data"]);

  const artifact = await writeSummaryArtifact(task.value, summary);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);

  emit(task.value, "agent.completed", "info", "issue-reader completed successfully", {
    issueNumber: summary.issueNumber,
    title: summary.title,
  });

  return ExitCode.Success;
}

async function readStdin(): Promise<string> {
  return readFileSync(0, "utf8");
}

function parseTask(rawTask: string): { ok: true; value: TaskEnvelope } | AgentFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTask);
  } catch (error) {
    console.error(`Invalid task JSON: ${(error as Error).message}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  const result = validateTaskEnvelope(parsed);
  if (!result.ok) {
    console.error("Invalid task envelope.");
    for (const validationError of result.errors) {
      console.error(JSON.stringify(validationError));
    }
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  return { ok: true, value: result.value };
}

async function writeSummaryArtifact(task: TaskEnvelope, summary: unknown) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });

  const artifactPath = path.join(artifactRoot, "issue-summary.json");
  const content = `${JSON.stringify(summary, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");

  return {
    artifactType: "issue.summary",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

async function readIssue(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | IssueFailure> {
  const issueNumber = Number(task.input.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return failure(
      "invalid_issue_number",
      "input.issueNumber must be a positive integer.",
      ExitCode.InvalidInput,
    );
  }

  if (!task.repository) {
    return failure(
      "missing_repository",
      "repository.owner and repository.name are required for real GitHub reads.",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    return failure(
      "missing_github_token",
      "Set GITHUB_TOKEN or GH_TOKEN to read a real GitHub issue.",
      ExitCode.MissingCapability,
    );
  }

  emit(task, "tool.requested", "info", `Fetching issue #${issueNumber}`, {
    tool: "github.issues.get",
    input: {
      owner: task.repository.owner,
      repo: task.repository.name,
      issue_number: issueNumber,
    },
  });

  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.issues.get({
      owner: task.repository.owner,
      repo: task.repository.name,
      issue_number: issueNumber,
    });
    const issue = response.data;

    if ("pull_request" in issue) {
      const message = `#${issueNumber} is a pull request, not an issue. Use a real issue number.`;
      emit(task, "tool.result", "error", `Issue #${issueNumber} is a pull request`, {
        tool: "github.issues.get",
        success: false,
        output: {
          code: "not_an_issue",
          message,
        },
      });

      return failure("not_an_issue", message, ExitCode.InvalidInput);
    }

    const summary = {
      issueNumber: issue.number,
      title: issue.title,
      repository: `${task.repository.owner}/${task.repository.name}`,
      state: issue.state,
      labels: issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(isString),
      body: issue.body ?? "",
      url: issue.html_url,
      author: issue.user?.login ?? null,
    };

    if (issue.state === "closed") {
      emit(
        task,
        "agent.output",
        "warn" as ProtocolEvent["level"],
        `Issue #${issueNumber} is already closed`,
        {
          warning: {
            code: "issue_already_closed",
            message: `Issue #${issueNumber} is already closed. Downstream agents will work on a resolved issue — verify this is intentional.`,
            issueNumber,
            state: issue.state,
          },
        },
      );
    }

    emit(task, "tool.result", "info", `Issue #${issueNumber} fetched`, {
      tool: "github.issues.get",
      success: true,
      output: {
        title: summary.title,
        state: summary.state,
        labels: summary.labels,
      },
    });

    return { ok: true, value: summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Issue #${issueNumber} fetch failed`, {
      tool: "github.issues.get",
      success: false,
      error: {
        code: "github_issue_read_failed",
        message,
      },
    });

    return failure("github_issue_read_failed", message, ExitCode.ExternalDependencyFailure);
  }
}

function failure(code: string, message: string, exitCode: number): IssueFailure {
  return { ok: false, code, message, exitCode };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function emit(
  task: TaskEnvelope,
  type: ProtocolEvent["type"],
  level: ProtocolEvent["level"],
  message: string,
  data: ProtocolEvent["data"],
): void {
  const event: ProtocolEvent = {
    protocolVersion: task.protocolVersion,
    eventId: `evt_${type.replaceAll(".", "_")}_${Date.now()}_${++eventSequence}`,
    runId: task.run.id,
    taskId: task.task.id,
    timestamp: new Date().toISOString(),
    type,
    level,
    message,
    data,
  };

  writeSync(1, `${JSON.stringify(event)}\n`);
}

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface IssueFailure extends AgentFailure {
  code: string;
  message: string;
}

type IssueSummary = ProtocolEvent["data"] & {
  issueNumber: number;
  title: string;
  repository: null | string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
