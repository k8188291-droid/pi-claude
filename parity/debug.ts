/**
 * Print the request trace the mock server saw for one scenario and harness.
 *   npx tsx parity/debug.ts <scenario> [claude|pi]
 */
import { MockAnthropicServer } from "./mock-server.js";
import { runClaude } from "./runners/claude-sdk.js";
import { runPi } from "./runners/pi.js";
import { scenarios } from "./scenarios/index.js";

const [name, harness = "pi"] = process.argv.slice(2);
const s = scenarios.find((x) => x.name === name);
if (!s) throw new Error(`unknown scenario ${name}; known: ${scenarios.map((x) => x.name).join(", ")}`);
const mock = new MockAnthropicServer();
const base = await mock.start();
const out = harness === "claude" ? await runClaude(s, mock, base, "claude-sonnet-4-6") : await runPi(s, mock, base, "claude-sonnet-4-6");
for (const r of mock.requests) {
	console.log(`${r.route} turn=${r.turnIndex} tools=${r.toolNames.length}`);
	for (const t of r.toolResults) console.log(`  ← ${t.toolUseId}${t.isError ? " (error)" : ""}: ${JSON.stringify(t.text.slice(0, 300))}`);
	if (!r.toolResults.length && r.lastUserText) console.log(`  user: ${JSON.stringify(r.lastUserText.slice(0, 300))}`);
}
if (out.error) console.log("run error:", out.error);
await mock.stop();
