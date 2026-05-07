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
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "pr.review") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `reviewer only supports pr.review, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "reviewer started", { agentVersion });

  const prInfo = await resolvePrInfoAsync(task.value);
  if (!prInfo.ok) return fail(task.value, prInfo);

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    const f = failure(
      "missing_github_token",
      "Set GITHUB_TOKEN or GH_TOKEN to fetch PR diffs.",
      ExitCode.MissingCapability,
    );
    return fail(task.value, f);
  }

  const auth = resolveBedrockConfig();
  if (!auth.ok) return fail(task.value, auth);

  emit(task.value, "tool.requested", "info", `Fetching diff for PR #${prInfo.value.prNumber}`, {
    tool: "github.pulls.get",
    input: {
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
      mediaType: "diff",
    },
  });

  const octokit = new Octokit({ auth: token });

  let diff: string;
  let prTitle: string;
  let prBody: string;
  let filesChanged: string[];
  try {
    const diffResponse = await octokit.pulls.get({
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
      mediaType: { format: "diff" },
    });
    diff = diffResponse.data as unknown as string;

    const metaResponse = await octokit.pulls.get({
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
    });
    prTitle = metaResponse.data.title;
    prBody = metaResponse.data.body ?? "";

    const filesResponse = await octokit.pulls.listFiles({
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
      per_page: 100,
    });
    filesChanged = filesResponse.data.map((file) => file.filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task.value, "tool.result", "error", "GitHub diff fetch failed", {
      tool: "github.pulls.get",
      success: false,
      error: { code: "github_diff_fetch_failed", message },
    });
    const f = failure("github_diff_fetch_failed", message, ExitCode.ExternalDependencyFailure);
    return fail(task.value, f);
  }

  emit(task.value, "tool.result", "info", `PR #${prInfo.value.prNumber} diff fetched`, {
    tool: "github.pulls.get",
    success: true,
    output: {
      prNumber: prInfo.value.prNumber,
      title: prTitle,
      filesChanged: filesChanged.length,
      diffLength: diff.length,
    },
  });

  emit(task.value, "tool.requested", "info", "Requesting review from Bedrock", {
    tool: "bedrock.converse",
    input: {
      provider: "aws-bedrock",
      region: auth.value.region,
      model: auth.value.model,
      prNumber: prInfo.value.prNumber,
      filesChanged: filesChanged.length,
    },
  });

  const reviewResult = await requestReview(auth.value, {
    prNumber: prInfo.value.prNumber,
    prTitle,
    prBody,
    diff,
    filesChanged,
  });

  if (!reviewResult.ok) {
    emit(task.value, "tool.result", "error", "Bedrock review failed", {
      tool: "bedrock.converse",
      success: false,
      error: { code: reviewResult.code, message: reviewResult.message },
    });
    return fail(task.value, reviewResult);
  }

  emit(task.value, "tool.result", "info", "Bedrock review received", {
    tool: "bedrock.converse",
    success: true,
    output: {
      region: auth.value.region,
      model: auth.value.model,
      stopReason: reviewResult.value.stopReason,
      inputTokens: reviewResult.value.inputTokens,
      outputTokens: reviewResult.value.outputTokens,
      decision: reviewResult.value.decision,
    },
  });

  const prUrl =
    prInfo.value.prUrl ??
    `https://github.com/${prInfo.value.owner}/${prInfo.value.repo}/pull/${prInfo.value.prNumber}`;

  // Post the review to GitHub so it's visible in the PR and the merge-gate can check it.
  emit(
    task.value,
    "tool.requested",
    "info",
    `Posting review to GitHub PR #${prInfo.value.prNumber}`,
    {
      tool: "github.pulls.createReview",
      input: {
        owner: prInfo.value.owner,
        repo: prInfo.value.repo,
        pull_number: prInfo.value.prNumber,
        event: reviewResult.value.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
      },
    },
  );

  try {
    await octokit.pulls.createReview({
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
      body: buildGithubReviewBody(reviewResult.value),
      event: reviewResult.value.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
    });
    emit(task.value, "tool.result", "info", "GitHub review posted", {
      tool: "github.pulls.createReview",
      success: true,
      output: { decision: reviewResult.value.decision },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Non-fatal: artifact is still written even if GitHub review fails.
    emit(task.value, "tool.result", "warn", "GitHub review post failed (non-fatal)", {
      tool: "github.pulls.createReview",
      success: false,
      error: { code: "github_review_post_failed", message },
    });
  }

  const output: ReviewResult = {
    decision: reviewResult.value.decision,
    prNumber: prInfo.value.prNumber,
    prUrl,
    summary: reviewResult.value.summary,
    comments: reviewResult.value.comments,
    risks: reviewResult.value.risks,
  };

  emit(task.value, "agent.output", "info", "PR review result created", output);

  const artifact = await writeResultArtifact(task.value, output);
  emit(task.value, "artifact.created", "info", "PR review result artifact created", artifact);

  emit(task.value, "agent.completed", "info", "reviewer completed successfully", {
    prNumber: prInfo.value.prNumber,
    decision: reviewResult.value.decision,
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

async function resolvePrInfoAsync(
  task: TaskEnvelope,
): Promise<{ ok: true; value: PrInfo } | ReviewerFailure> {
  const directPr = parsePrInput(task.input.pr, task.repository);
  if (directPr.ok) return directPr;

  const artifact = task.context?.priorArtifacts?.find(
    (candidate) => candidate.artifactType === "pr.opened",
  );
  if (!artifact) {
    return failure(
      "missing_pr_info",
      "reviewer requires input.pr (with prNumber and repository owner/name) or a prior pr.opened artifact.",
      ExitCode.InvalidInput,
    );
  }

  if (artifact.uri.startsWith("file://")) {
    let raw: string;
    try {
      raw = await fs.readFile(new URL(artifact.uri), "utf8");
    } catch (error) {
      return failure(
        "artifact_read_failed",
        `Could not read pr.opened artifact: ${(error as Error).message}`,
        ExitCode.InvalidInput,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return failure(
        "invalid_artifact_json",
        `pr.opened artifact is not valid JSON: ${(error as Error).message}`,
        ExitCode.InvalidInput,
      );
    }

    if (!isObject(parsed)) {
      return failure(
        "invalid_artifact_json",
        "pr.opened artifact must be a JSON object.",
        ExitCode.InvalidInput,
      );
    }

    const prNumber = Number(parsed.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return failure(
        "invalid_artifact_json",
        "pr.opened artifact must include a valid prNumber.",
        ExitCode.InvalidInput,
      );
    }

    const owner =
      task.repository?.owner ??
      (isObject(parsed.repository) ? String(parsed.repository.owner ?? "") : "");
    const repo =
      task.repository?.name ??
      (isObject(parsed.repository) ? String(parsed.repository.name ?? "") : "");

    if (!owner || !repo) {
      return failure(
        "missing_repository",
        "Could not determine repository owner/name from artifact or task envelope.",
        ExitCode.InvalidInput,
      );
    }

    return {
      ok: true,
      value: {
        prNumber,
        owner,
        repo,
        prUrl: typeof parsed.prUrl === "string" ? parsed.prUrl : null,
      },
    };
  }

  const urlMatch = artifact.uri.match(/\/pull\/(\d+)/);
  if (!urlMatch || !task.repository) {
    return failure(
      "missing_pr_info",
      "Could not extract PR number from artifact URI.",
      ExitCode.InvalidInput,
    );
  }

  return {
    ok: true,
    value: {
      prNumber: Number(urlMatch[1]),
      owner: task.repository.owner,
      repo: task.repository.name,
      prUrl: artifact.uri.startsWith("http") ? artifact.uri : null,
    },
  };
}

function parsePrInput(
  value: JsonValue | undefined,
  repository: TaskEnvelope["repository"],
): { ok: true; value: PrInfo } | { ok: false } {
  if (!isObject(value)) return { ok: false };

  const prNumber = Number(value.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false };

  const owner = resolveOwner(value, repository);
  const repo = resolveRepo(value, repository);
  if (!owner || !repo) return { ok: false };

  return {
    ok: true,
    value: {
      prNumber,
      owner,
      repo,
      prUrl: typeof value.prUrl === "string" ? value.prUrl : null,
    },
  };
}

function resolveOwner(value: JsonObject, repository: TaskEnvelope["repository"]): null | string {
  if (isObject(value.repository) && typeof value.repository.owner === "string") {
    return value.repository.owner;
  }
  if (repository) return repository.owner;
  return null;
}

function resolveRepo(value: JsonObject, repository: TaskEnvelope["repository"]): null | string {
  if (isObject(value.repository) && typeof value.repository.name === "string") {
    return value.repository.name;
  }
  if (repository) return repository.name;
  return null;
}

function resolveBedrockConfig(): { ok: true; value: BedrockConfig } | ReviewerFailure {
  if (!hasBedrockAuth()) {
    return failure(
      "missing_llm_api_key",
      "Set AWS_BEARER_TOKEN_BEDROCK or standard AWS credentials so reviewer can call Bedrock.",
      ExitCode.MissingCapability,
    );
  }

  return {
    ok: true,
    value: {
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      model: process.env.ANCHORAGE_REVIEWER_MODEL ?? "us.anthropic.claude-sonnet-4-6",
    },
  };
}

function hasBedrockAuth(): boolean {
  return Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

async function requestReview(
  config: BedrockConfig,
  pr: PrContext,
): Promise<{ ok: true; value: BedrockReviewResult } | ReviewerFailure> {
  let response: unknown;
  try {
    const client = new BedrockRuntimeClient({ region: config.region });
    response = await client.send(
      new ConverseCommand({
        modelId: config.model,
        system: [{ text: reviewerSystemPrompt() }],
        messages: [{ role: "user", content: [{ text: reviewerUserPrompt(pr) }] }],
        inferenceConfig: { maxTokens: 4000, temperature: 0.1 },
      }),
    );
  } catch (error) {
    return failure(
      "llm_request_failed",
      error instanceof Error ? error.message : String(error),
      ExitCode.ExternalDependencyFailure,
    );
  }

  const parsedResponse = parseBedrockResponse(response);
  if (!parsedResponse.ok) {
    return failure(
      "invalid_llm_response",
      parsedResponse.message,
      ExitCode.ExternalDependencyFailure,
    );
  }

  const parsedJson = parseReviewJson(parsedResponse.text);
  if (!parsedJson.ok) {
    return failure(
      "invalid_llm_review_json",
      parsedJson.message,
      ExitCode.ExternalDependencyFailure,
    );
  }

  const normalized = normalizeReviewResult(parsedJson.value, parsedResponse);
  if (!normalized.ok) {
    return failure(
      "invalid_llm_review_result",
      normalized.message,
      ExitCode.ExternalDependencyFailure,
    );
  }

  return { ok: true, value: normalized.value };
}

function reviewerSystemPrompt(): string {
  return `You are Anchorage reviewer, a code review agent in a CLI-first multi-agent software workflow.
Return only strict JSON. Do not wrap it in markdown.
You receive a PR diff, title, body, and list of changed files.
Review the PR for:
- Scope: does the diff match the PR title/description? Are there out-of-scope changes?
- Safety: no secrets, no destructive operations, no out-of-scope changes that could harm the system.
- Quality: follows existing patterns, no obvious bugs, reasonable code structure.

Emit an approve or request_changes decision.
The JSON shape must be:
{
  "decision": "approve" | "request_changes",
  "summary": string,
  "comments": [{"path": string, "line": number | null, "body": string}],
  "risks": string[]
}

If the PR is safe and well-scoped, approve it. Only request changes for substantive issues.`;
}

function reviewerUserPrompt(pr: PrContext): string {
  return JSON.stringify(
    {
      task: "Review this pull request diff and provide a decision.",
      pr: {
        number: pr.prNumber,
        title: pr.prTitle,
        body: pr.prBody,
        filesChanged: pr.filesChanged,
      },
      diff: pr.diff,
      constraints: [
        "Return only JSON matching the requested shape.",
        "decision must be exactly 'approve' or 'request_changes'.",
        "comments should reference specific file paths and line numbers where possible.",
        "risks should list any potential issues even if you approve.",
      ],
    },
    null,
    2,
  );
}

function parseBedrockResponse(
  value: unknown,
):
  | { ok: true; text: string; stopReason: null | string; inputTokens: number; outputTokens: number }
  | { ok: false; message: string } {
  if (!isObject(value)) return { ok: false, message: "Bedrock response was not an object." };
  const output = isObject(value.output) ? value.output : {};
  const message = isObject(output.message) ? output.message : {};
  if (!Array.isArray(message.content)) {
    return { ok: false, message: "Bedrock response did not include output.message.content[]." };
  }

  const text = message.content
    .map((block) => (isObject(block) ? block.text : null))
    .filter(isString)
    .join("\n")
    .trim();
  if (!text) return { ok: false, message: "Bedrock response did not include text content." };

  const usage = isObject(value.usage) ? value.usage : {};
  return {
    ok: true,
    text,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : null,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
  };
}

function parseReviewJson(
  value: string,
): { ok: true; value: JsonObject } | { ok: false; message: string } {
  const json = extractJsonObject(value);
  if (!json) return { ok: false, message: "LLM response did not contain a JSON object." };
  try {
    const parsed = JSON.parse(json);
    if (!isObject(parsed)) return { ok: false, message: "LLM review JSON was not an object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `LLM review JSON was invalid: ${(error as Error).message}` };
  }
}

function extractJsonObject(value: string): null | string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return value.slice(start, end + 1);
}

function normalizeReviewResult(
  value: JsonObject,
  response: { stopReason: null | string; inputTokens: number; outputTokens: number },
): { ok: true; value: BedrockReviewResult } | { ok: false; message: string } {
  const decision = value.decision;
  if (decision !== "approve" && decision !== "request_changes") {
    return {
      ok: false,
      message: "LLM review JSON decision must be 'approve' or 'request_changes'.",
    };
  }

  const comments: ReviewComment[] = [];
  if (Array.isArray(value.comments)) {
    for (const entry of value.comments) {
      if (!isObject(entry)) continue;
      if (typeof entry.path !== "string" || typeof entry.body !== "string") continue;
      comments.push({
        path: entry.path,
        line: typeof entry.line === "number" ? entry.line : null,
        body: entry.body,
      });
    }
  }

  return {
    ok: true,
    value: {
      decision,
      summary: typeof value.summary === "string" ? value.summary : "",
      comments,
      risks: Array.isArray(value.risks) ? value.risks.filter(isString) : [],
      stopReason: response.stopReason,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function buildGithubReviewBody(result: {
  decision: string;
  summary: string;
  comments: Array<{ path: string; line: number | null; body: string }>;
  risks: string[];
}): string {
  const lines: string[] = [];
  const icon = result.decision === "approve" ? "✅" : "⚠️";
  lines.push(
    `${icon} **Anchorage automated review** — ${result.decision === "approve" ? "Approved" : "Changes requested"}`,
  );
  lines.push("");
  lines.push(result.summary);
  if (result.risks.length > 0) {
    lines.push("");
    lines.push("**Risks:**");
    for (const risk of result.risks) lines.push(`- ${risk}`);
  }
  if (result.comments.length > 0) {
    lines.push("");
    lines.push("**Inline notes:**");
    for (const comment of result.comments) {
      const location = comment.line ? `\`${comment.path}:${comment.line}\`` : `\`${comment.path}\``;
      lines.push(`- ${location}: ${comment.body}`);
    }
  }
  return lines.join("\n");
}

async function writeResultArtifact(task: TaskEnvelope, result: ReviewResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });

  const artifactPath = path.join(artifactRoot, "pr-review-result.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");

  return {
    artifactType: "pr.review.result",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function fail(task: TaskEnvelope, failureValue: ReviewerFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): ReviewerFailure {
  return { ok: false, code, message, exitCode };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface ReviewerFailure extends AgentFailure {
  code: string;
  message: string;
}

interface PrInfo {
  prNumber: number;
  owner: string;
  repo: string;
  prUrl: null | string;
}

interface BedrockConfig {
  region: string;
  model: string;
}

interface PrContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;
  filesChanged: string[];
}

type ReviewComment = JsonObject & {
  path: string;
  line: null | number;
  body: string;
};

interface BedrockReviewResult {
  decision: "approve" | "request_changes";
  summary: string;
  comments: ReviewComment[];
  risks: string[];
  stopReason: null | string;
  inputTokens: number;
  outputTokens: number;
}

type ReviewResult = ProtocolEvent["data"] & {
  decision: "approve" | "request_changes";
  prNumber: number;
  prUrl: string;
  summary: string;
  comments: ReviewComment[];
  risks: string[];
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
