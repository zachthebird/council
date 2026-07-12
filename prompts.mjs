/** Stage prompts for the council pipeline. The critique wording follows the
 * product spec: each model evaluates its counterpart's work relative to its
 * own, then a chosen leader integrates strengths and addresses weaknesses. */

export function generatePrompt(userPrompt) {
  return [
    userPrompt.trim(),
    "",
    "Work entirely inside the current working directory. Build a complete,",
    "working solution: create real files, and if the project has a natural",
    "way to run or test it, make sure that works. When you are finished,",
    "summarize what you built and how to run it.",
  ].join("\n");
}

export function critiquePrompt(counterpartName, counterpartCode) {
  return [
    `Another agent counterpart (${counterpartName}) was just given the same`,
    "prompt you were; however they returned somewhat different results.",
    "Their complete solution is included below.",
    "",
    "Evaluate their codebase relative to your own, looking for areas of",
    "improvement, new strategies and approaches, missteps - anything you can",
    "find to improve the strength of the final solution. The counterpart",
    "model is performing the exact same exercise on your code right now.",
    "",
    "Do NOT modify any files during this step. Reply with a structured",
    "critique containing exactly these sections:",
    "1. STRENGTHS OF THEIRS - concrete things worth adopting.",
    "2. WEAKNESSES OF THEIRS - concrete missteps or risks in their approach.",
    "3. HONEST COMPARISON - which solution is currently the stronger base",
    "   and why, in a few sentences.",
    "",
    `=== BEGIN ${counterpartName.toUpperCase()} SOLUTION ===`,
    counterpartCode,
    `=== END ${counterpartName.toUpperCase()} SOLUTION ===`,
  ].join("\n");
}

export function integratePrompt(ownCritiqueOfCounterpart, counterpartCritiqueOfOwn) {
  return [
    "You have been selected as the LEADER: your solution is the base for the",
    "final implementation.",
    "",
    "Below are two critiques: your counterpart's critique of YOUR solution,",
    "and your own earlier critique of THEIR solution. Strengthen the final",
    "result as much as possible: work in the genuine strengths identified in",
    "the counterpart's approach, and address every legitimate weakness the",
    "counterpart found in yours. If a criticism is wrong, you may reject it,",
    "but say so explicitly in your summary. Modify the files in your working",
    "directory now, then summarize exactly what you changed and why.",
    "",
    "=== COUNTERPART'S CRITIQUE OF YOUR SOLUTION ===",
    counterpartCritiqueOfOwn,
    "",
    "=== YOUR EARLIER CRITIQUE OF THEIR SOLUTION (for reference) ===",
    ownCritiqueOfCounterpart,
  ].join("\n");
}

export function finalReviewPrompt(leaderName, leaderCode) {
  return [
    `The leader (${leaderName}) has finalized the solution; the complete`,
    "updated code is below. Perform one last review prior to publication.",
    "",
    "Reply with exactly APPROVE or REQUEST_CHANGES as the first line of your",
    "response, followed by your reasoning and any findings. Only use",
    "REQUEST_CHANGES for genuine defects or unaddressed weaknesses, not",
    "stylistic preference. Do NOT modify any files.",
    "",
    `=== BEGIN FINAL ${leaderName.toUpperCase()} SOLUTION ===`,
    leaderCode,
    `=== END FINAL ${leaderName.toUpperCase()} SOLUTION ===`,
  ].join("\n");
}

export function revisePrompt(reviewFeedback) {
  return [
    "The counterpart's final review requested changes before publication.",
    "Their full review is below. Address every legitimate finding, modify",
    "the files now, and summarize what you changed. If you reject a finding,",
    "say so explicitly and justify it.",
    "",
    "=== FINAL REVIEW FEEDBACK ===",
    reviewFeedback,
  ].join("\n");
}
