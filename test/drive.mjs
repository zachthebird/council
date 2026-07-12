#!/usr/bin/env node
/** Test driver: runs one full council cycle against the local server,
 * auto-picking the given leader and publishing at the gate. */
const BASE = "http://127.0.0.1:4700";
const [prompt, leader] = process.argv.slice(2);

const api = async (path, init) => {
  const response = await fetch(BASE + path, init);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const post = (path, body) => api(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = await post("/api/runs", { prompt });
console.log("run:", run.id);
let picked = false;
let published = false;
for (let i = 0; i < 120; i += 1) {
  const state = await api(`/api/runs/${run.id}`);
  console.log(`[${i}] ${state.stage} claude=${state.actorStatus.claude} codex=${state.actorStatus.codex} verdict=${state.verdict ?? "-"}`);
  if (state.stage === "failed") { console.error("FAILED:", state.error); process.exit(1); }
  if (state.stage === "awaiting_leader" && !picked) {
    picked = true;
    console.log("critique claude:", (state.critiques.claude ?? "").slice(0, 80).replaceAll("\n", " "));
    console.log("critique codex:", (state.critiques.codex ?? "").slice(0, 80).replaceAll("\n", " "));
    await post(`/api/runs/${run.id}/leader`, { leader });
  }
  if (state.stage === "awaiting_publish" && !published) {
    published = true;
    console.log("final review:", (state.finalReview ?? "").slice(0, 120).replaceAll("\n", " "));
    await post(`/api/runs/${run.id}/publish`);
  }
  if (state.stage === "published") {
    console.log("PUBLISHED:", JSON.stringify(state.published));
    process.exit(0);
  }
  await sleep(5000);
}
console.error("timed out");
process.exit(1);
