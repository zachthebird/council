// Minimal readline prompt for interactive gates. Restores the terminal cleanly.
import { createInterface } from 'node:readline';

export function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
