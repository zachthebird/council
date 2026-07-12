#!/usr/bin/env node
/** Deterministic stand-in for the `claude` CLI used to exercise the full
 * council stage machine without live Claude credentials. Emits the same
 * stream-json event shapes the real CLI produces and reacts to each stage
 * prompt: generate writes files, critique/review reply with text only. */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const text = (value) =>
  emit({ type: "assistant", message: { content: [{ type: "text", text: value }] }, session_id: sessionId });
const tool = (name, input) =>
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, session_id: sessionId });

emit({ type: "system", subtype: "init", session_id: sessionId });

let final;
if (prompt.includes("FINAL") && prompt.includes("one last review")) {
  final = "APPROVE\n\nThe leader addressed the earlier findings; the solution is fit to publish.";
} else if (prompt.includes("counterpart") && prompt.includes("Do NOT modify any files")) {
  final = [
    "1. STRENGTHS OF THEIRS - runs the script during generation to prove it works; concise README.",
    "2. WEAKNESSES OF THEIRS - output is not importable as a module; no guard for other ranges.",
    "3. HONEST COMPARISON - their solution is a competent base; mine differs mainly in structure.",
  ].join("\n");
} else if (prompt.includes("selected as the LEADER") || prompt.includes("requested changes")) {
  tool("Edit", { file_path: "fizzbuzz.py" });
  writeFileSync("fizzbuzz.py", 'def fizzbuzz(n):\n    for i in range(1, n + 1):\n        print("FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else i)\n\nif __name__ == "__main__":\n    fizzbuzz(30)\n');
  final = "Integrated the counterpart's importable-module strength and kept the runnable entrypoint.";
} else {
  tool("Write", { file_path: "fizzbuzz.py" });
  writeFileSync("fizzbuzz.py", 'for i in range(1, 31):\n    print("FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else i)\n');
  tool("Write", { file_path: "README.md" });
  writeFileSync("README.md", "# FizzBuzz\n\nRun: `python3 fizzbuzz.py`\n");
  final = "Created fizzbuzz.py and README.md. Run with python3 fizzbuzz.py.";
}
text(final);
emit({ type: "result", subtype: "success", result: final, session_id: sessionId });
