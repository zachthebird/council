#!/usr/bin/env node
/**
 * Council orchestrator: runs one prompt through Claude and Codex
 * independently, streams both agents' activity to the GUI, then walks the
 * council stages: cross-critique -> leader selection -> leader integration ->
 * counterpart final review -> publish to a git branch.
 *
 * Zero runtime dependencies; agents are the vendors' own headless CLIs.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  critiquePrompt,
  finalReviewPrompt,
  generatePrompt,
  integratePrompt,
  revisePrompt,
} from "./prompts.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = join(ROOT, "runs");
const PORT = Number(process.env.COUNCIL_PORT ?? 4700);
const CLAUDE_BIN = process.env.COUNCIL_CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.COUNCIL_CODEX_BIN
  ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const MAX_SHARED_CODE_CHARS = 60_000;
const ACTORS = ["claude", "codex"];

/** @type {Map<string, Run>} */
const runs = new Map();

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function commitAll(cwd, message) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, [
    "-c", "user.name=Council",
    "-c", "user.email=council@localhost",
    "commit", "--allow-empty", "-q", "-m", message,
  ]);
}

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar",
  "woff", "woff2", "ttf", "eot", "mp3", "mp4", "mov", "sqlite", "db", "node",
]);

/** Dump every tracked file as one bounded text blob for the counterpart. */
async function collectCode(cwd) {
  const files = (await git(cwd, ["ls-files"])).split("\n").filter(Boolean);
  const parts = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    const extension = file.split(".").pop()?.toLowerCase() ?? "";
    if (BINARY_EXTENSIONS.has(extension)) {
      parts.push(`--- ${file} ---\n<binary file omitted>\n`);
      continue;
    }
    let content;
    try {
      content = await readFile(join(cwd, file), "utf8");
    } catch {
      parts.push(`--- ${file} ---\n<unreadable, omitted>\n`);
      continue;
    }
    const block = `--- ${file} ---\n${content}\n`;
    if (used + block.length > MAX_SHARED_CODE_CHARS) {
      truncated = true;
      break;
    }
    parts.push(block);
    used += block.length;
  }
  if (files.length === 0) parts.push("<no files were created>");
  if (truncated) parts.push("\n<remaining files truncated to fit the exchange size budget>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent adapters: both return { sessionId, finalText } and stream events.
// ---------------------------------------------------------------------------

function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
    }
  };
}

function summarizeToolInput(input) {
  if (input === null || typeof input !== "object") return "";
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? "";
  return String(value).replaceAll("\n", " ").slice(0, 160);
}

/** Nested-session variables from a parent Claude/Anthropic process confuse the
 * child CLI's auth and session handling; children get a scrubbed environment. */
function claudeChildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ANTHROPIC_API_KEY") { env[key] = value; continue; }
    if (/^(CLAUDECODE|CLAUDE_|ANTHROPIC_)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function runClaude(run, workspace, prompt, resumeSession) {
  const args = [
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  return runAgentProcess(run, "claude", CLAUDE_BIN, args, workspace, (line, state) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      state.sessionId = event.session_id ?? state.sessionId;
      return;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const item of event.message.content) {
        if (item.type === "text" && item.text?.trim()) {
          state.lastText = item.text;
          emit(run, "claude", "text", item.text);
        } else if (item.type === "tool_use") {
          emit(run, "claude", "tool", `${item.name}  ${summarizeToolInput(item.input)}`);
        }
      }
      return;
    }
    if (event.type === "result") {
      state.sessionId = event.session_id ?? state.sessionId;
      if (typeof event.result === "string" && event.result.trim()) state.lastText = event.result;
    }
  });
}

function runCodex(run, workspace, prompt, resumeSession) {
  // exec-level options must precede the `resume` subcommand.
  const common = ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", workspace];
  const args = resumeSession
    ? [...common, "resume", resumeSession, prompt]
    : [...common, prompt];
  return runAgentProcess(run, "codex", CODEX_BIN, args, workspace, (line, state) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // The exec JSONL schema is still moving (alpha CLI); extract defensively.
    state.sessionId = event.thread_id ?? event.session_id ?? event.thread?.id ?? state.sessionId;
    const item = event.item ?? event;
    const type = item.item_type ?? item.type ?? event.type ?? "";
    if (typeof item.text === "string" && item.text.trim() &&
        String(type).includes("message") && !String(event.type ?? "").includes("started")) {
      state.lastText = item.text;
      emit(run, "codex", "text", item.text);
      return;
    }
    if (typeof item.command === "string" && String(event.type ?? "").endsWith("started")) {
      emit(run, "codex", "tool", `shell  ${item.command.replaceAll("\n", " ").slice(0, 160)}`);
      return;
    }
    if (String(type).includes("file_change") || String(type).includes("patch")) {
      const files = Array.isArray(item.changes)
        ? item.changes.map((change) => change.path ?? "").filter(Boolean).join(", ")
        : "";
      emit(run, "codex", "tool", `edit  ${files.slice(0, 160)}`);
    }
  });
}

function runAgentProcess(run, actor, binary, args, workspace, onLine) {
  return new Promise((resolvePromise, rejectPromise) => {
    const state = { sessionId: undefined, lastText: "" };
    const child = spawn(binary, args, {
      cwd: workspace,
      env: actor === "claude" ? claudeChildEnv() : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.children.add(child);
    child.stdout.on("data", lineSplitter((line) => {
      try {
        onLine(line, state);
      } catch {
        // A malformed stream line must never kill the stage.
      }
    }));
    const stderrTail = [];
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) stderrTail.push(text.slice(0, 400));
      while (stderrTail.length > 5) stderrTail.shift();
    });
    child.on("error", (error) => {
      run.children.delete(child);
      rejectPromise(new Error(`${actor} process failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      run.children.delete(child);
      if (code === 0) {
        resolvePromise({ sessionId: state.sessionId, finalText: state.lastText });
      } else {
        rejectPromise(new Error(
          `${actor} exited with code ${code}${stderrTail.length ? `: ${stderrTail.join(" | ")}` : ""}`,
        ));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

class Run {
  constructor(id, prompt, seedRepo) {
    this.id = id;
    this.prompt = prompt;
    this.seedRepo = seedRepo ?? null;
    this.stage = "created";
    this.leader = null;
    this.verdict = null;
    this.error = null;
    this.sessions = { claude: null, codex: null };
    this.critiques = { claude: null, codex: null };
    this.finalReview = null;
    this.published = null;
    this.actorStatus = { claude: "idle", codex: "idle" };
    this.createdAt = new Date().toISOString();
    this.clients = new Set();
    this.children = new Set();
  }

  dir() { return join(RUNS_DIR, this.id); }
  workspace(actor) { return join(this.dir(), actor); }

  snapshot() {
    return {
      id: this.id,
      prompt: this.prompt,
      seedRepo: this.seedRepo,
      stage: this.stage,
      leader: this.leader,
      verdict: this.verdict,
      error: this.error,
      sessions: this.sessions,
      critiques: this.critiques,
      finalReview: this.finalReview,
      published: this.published,
      actorStatus: this.actorStatus,
      createdAt: this.createdAt,
    };
  }
}

/** Stages that cannot survive a dead server because an agent turn was in
 * flight; runs found in these stages at startup are marked interrupted. */
const IN_FLIGHT_STAGES = new Set(["created", "generating", "critiquing", "integrating", "final_review"]);

async function rehydrateRuns() {
  let entries;
  try {
    entries = await readdir(RUNS_DIR);
  } catch {
    return;
  }
  const restored = [];
  for (const id of entries) {
    let state;
    try {
      state = JSON.parse(await readFile(join(RUNS_DIR, id, "state.json"), "utf8"));
    } catch {
      continue;
    }
    const run = new Run(state.id ?? id, state.prompt ?? "", state.seedRepo ?? null);
    run.stage = state.stage ?? "failed";
    run.leader = state.leader ?? null;
    run.verdict = state.verdict ?? null;
    run.error = state.error ?? null;
    run.sessions = state.sessions ?? { claude: null, codex: null };
    run.critiques = state.critiques ?? { claude: null, codex: null };
    run.finalReview = state.finalReview ?? null;
    run.published = state.published ?? null;
    run.actorStatus = state.actorStatus ?? { claude: "idle", codex: "idle" };
    run.createdAt = state.createdAt ?? new Date(0).toISOString();
    if (IN_FLIGHT_STAGES.has(run.stage)) {
      run.error = "interrupted by a server restart; start a new run";
      for (const actor of ACTORS) {
        if (run.actorStatus[actor] === "working") run.actorStatus[actor] = "failed";
      }
      run.stage = "failed";
      emit(run, "system", "note", run.error);
      setStage(run, "failed");
    }
    restored.push(run);
  }
  restored.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of restored) runs.set(run.id, run);
  if (restored.length > 0) console.log(`rehydrated ${restored.length} run(s) from disk`);
}

function emit(run, actor, kind, text) {
  const event = { ts: new Date().toISOString(), actor, kind, text };
  const line = JSON.stringify(event);
  appendFile(join(run.dir(), "events.jsonl"), `${line}\n`).catch(() => undefined);
  for (const client of run.clients) client.write(`data: ${line}\n\n`);
}

function setStage(run, stage) {
  run.stage = stage;
  emit(run, "system", "stage", JSON.stringify(run.snapshot()));
  writeFile(join(run.dir(), "state.json"), JSON.stringify(run.snapshot(), null, 2))
    .catch(() => undefined);
}

async function createRun(prompt, seedRepo) {
  const id = randomUUID().slice(0, 8);
  const run = new Run(id, prompt, seedRepo);
  await mkdir(run.dir(), { recursive: true });
  for (const actor of ACTORS) {
    const workspace = run.workspace(actor);
    if (seedRepo) {
      const seed = resolve(seedRepo);
      if (!existsSync(join(seed, ".git"))) throw new Error("seed repo is not a git repository");
      await execFileAsync("git", ["clone", "--no-hardlinks", "-q", seed, workspace]);
    } else {
      await mkdir(workspace, { recursive: true });
      await git(workspace, ["init", "-q", "-b", "main"]);
      await commitAll(workspace, "council: empty base");
    }
  }
  runs.set(id, run);
  setStage(run, "generating");
  void generateStage(run);
  return run;
}

async function generateStage(run) {
  const prompt = generatePrompt(run.prompt);
  await Promise.all(ACTORS.map(async (actor) => {
    run.actorStatus[actor] = "working";
    emit(run, actor, "status", "generating solution");
    try {
      const runner = actor === "claude" ? runClaude : runCodex;
      const result = await runner(run, run.workspace(actor), prompt, null);
      run.sessions[actor] = result.sessionId ?? null;
      await commitAll(run.workspace(actor), `council: generate (${actor})`);
      run.actorStatus[actor] = "done";
      emit(run, actor, "status", "generation complete");
    } catch (error) {
      run.actorStatus[actor] = "failed";
      emit(run, actor, "error", String(error.message ?? error));
    }
  }));
  const survivors = ACTORS.filter((actor) => run.actorStatus[actor] === "done");
  if (survivors.length === 0) {
    run.error = "both agents failed during generation";
    setStage(run, "failed");
    return;
  }
  if (survivors.length === 1) {
    emit(run, "system", "note", `${survivors[0]} is the only surviving solution; skipping critique`);
    run.leader = survivors[0];
    setStage(run, "awaiting_publish");
    return;
  }
  await critiqueStage(run);
}

async function critiqueStage(run) {
  setStage(run, "critiquing");
  const code = {};
  for (const actor of ACTORS) code[actor] = await collectCode(run.workspace(actor));
  await Promise.all(ACTORS.map(async (actor) => {
    const counterpart = actor === "claude" ? "codex" : "claude";
    run.actorStatus[actor] = "working";
    emit(run, actor, "status", `critiquing ${counterpart}'s solution`);
    try {
      const runner = actor === "claude" ? runClaude : runCodex;
      const result = await runner(
        run,
        run.workspace(actor),
        critiquePrompt(counterpart, code[counterpart]),
        run.sessions[actor],
      );
      run.sessions[actor] = result.sessionId ?? run.sessions[actor];
      run.critiques[actor] = result.finalText || "(no critique text captured)";
      run.actorStatus[actor] = "done";
    } catch (error) {
      run.actorStatus[actor] = "failed";
      run.critiques[actor] = `(critique failed: ${String(error.message ?? error)})`;
      emit(run, actor, "error", String(error.message ?? error));
    }
  }));
  setStage(run, "awaiting_leader");
}

async function integrateStage(run, leader) {
  run.leader = leader;
  const counterpart = leader === "claude" ? "codex" : "claude";
  setStage(run, "integrating");
  run.actorStatus[leader] = "working";
  emit(run, leader, "status", "integrating counterpart strengths as leader");
  try {
    const runner = leader === "claude" ? runClaude : runCodex;
    const result = await runner(
      run,
      run.workspace(leader),
      integratePrompt(run.critiques[leader] ?? "", run.critiques[counterpart] ?? ""),
      run.sessions[leader],
    );
    run.sessions[leader] = result.sessionId ?? run.sessions[leader];
    await commitAll(run.workspace(leader), "council: leader integration");
    run.actorStatus[leader] = "done";
  } catch (error) {
    run.error = `leader integration failed: ${String(error.message ?? error)}`;
    setStage(run, "failed");
    return;
  }
  await finalReviewStage(run);
}

async function finalReviewStage(run) {
  const leader = run.leader;
  const counterpart = leader === "claude" ? "codex" : "claude";
  setStage(run, "final_review");
  run.actorStatus[counterpart] = "working";
  emit(run, counterpart, "status", "performing final pre-publication review");
  try {
    const runner = counterpart === "claude" ? runClaude : runCodex;
    const result = await runner(
      run,
      run.workspace(counterpart),
      finalReviewPrompt(leader, await collectCode(run.workspace(leader))),
      run.sessions[counterpart],
    );
    run.sessions[counterpart] = result.sessionId ?? run.sessions[counterpart];
    run.finalReview = result.finalText || "(no review text captured)";
    const firstLine = run.finalReview.trim().split("\n")[0]?.toUpperCase() ?? "";
    run.verdict = firstLine.includes("REQUEST_CHANGES") ? "REQUEST_CHANGES" : "APPROVE";
    run.actorStatus[counterpart] = "done";
  } catch (error) {
    run.finalReview = `(final review failed: ${String(error.message ?? error)})`;
    run.verdict = "REVIEW_FAILED";
    run.actorStatus[counterpart] = "failed";
  }
  setStage(run, "awaiting_publish");
}

async function reviseStage(run) {
  const leader = run.leader;
  setStage(run, "integrating");
  run.actorStatus[leader] = "working";
  emit(run, leader, "status", "revising after final-review findings");
  try {
    const runner = leader === "claude" ? runClaude : runCodex;
    await runner(run, run.workspace(leader), revisePrompt(run.finalReview ?? ""), run.sessions[leader]);
    await commitAll(run.workspace(leader), "council: post-review revision");
    run.actorStatus[leader] = "done";
  } catch (error) {
    run.error = `revision failed: ${String(error.message ?? error)}`;
    setStage(run, "failed");
    return;
  }
  await finalReviewStage(run);
}

async function publishRun(run) {
  const workspace = run.workspace(run.leader);
  await commitAll(workspace, "council: published result");
  const branch = `council/${run.id}`;
  await git(workspace, ["branch", "-f", branch]);
  run.published = { path: workspace, branch, leader: run.leader, verdict: run.verdict };
  setStage(run, "published");
}

// ---------------------------------------------------------------------------
// HTTP + SSE
// ---------------------------------------------------------------------------

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await readFile(join(ROOT, "public", "index.html")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/runs") {
      json(response, 200, [...runs.values()].map((run) => run.snapshot()).reverse());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(request);
      const prompt = String(body.prompt ?? "").trim();
      if (prompt.length === 0) return json(response, 400, { error: "prompt is required" });
      const run = await createRun(prompt, body.seedRepo ? String(body.seedRepo) : null);
      json(response, 200, run.snapshot());
      return;
    }

    if (parts[0] === "api" && parts[1] === "runs" && parts[2] !== undefined) {
      const run = runs.get(parts[2]);
      if (run === undefined) return json(response, 404, { error: "run not found" });

      if (request.method === "GET" && parts[3] === "events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const eventsPath = join(run.dir(), "events.jsonl");
        if (existsSync(eventsPath)) {
          const replay = await readFile(eventsPath, "utf8");
          for (const line of replay.split("\n")) {
            if (line.trim()) response.write(`data: ${line}\n\n`);
          }
        }
        response.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), actor: "system", kind: "stage", text: JSON.stringify(run.snapshot()) })}\n\n`);
        run.clients.add(response);
        request.on("close", () => run.clients.delete(response));
        return;
      }

      if (request.method === "GET" && parts[3] === undefined) {
        return json(response, 200, run.snapshot());
      }

      if (request.method === "POST" && parts[3] === "leader") {
        const body = await readBody(request);
        const leader = String(body.leader ?? "");
        if (!ACTORS.includes(leader)) return json(response, 400, { error: "leader must be claude or codex" });
        if (run.stage !== "awaiting_leader") return json(response, 409, { error: `cannot pick a leader during ${run.stage}` });
        void integrateStage(run, leader);
        return json(response, 200, { ok: true });
      }

      if (request.method === "POST" && parts[3] === "revise") {
        if (run.stage !== "awaiting_publish") return json(response, 409, { error: `cannot revise during ${run.stage}` });
        void reviseStage(run);
        return json(response, 200, { ok: true });
      }

      if (request.method === "POST" && parts[3] === "publish") {
        if (run.stage !== "awaiting_publish") return json(response, 409, { error: `cannot publish during ${run.stage}` });
        await publishRun(run);
        return json(response, 200, run.snapshot());
      }
    }

    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, { error: String(error.message ?? error) });
  }
});

function shutdown() {
  for (const run of runs.values()) {
    for (const child of run.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort cleanup; the process is exiting regardless.
      }
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await mkdir(RUNS_DIR, { recursive: true });
await rehydrateRuns();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`council listening on http://127.0.0.1:${PORT}`);
});
