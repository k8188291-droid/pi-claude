/**
 * Record a real Claude Code session (via the Agent SDK, real Anthropic API) for later replay.
 *
 *   ANTHROPIC_API_KEY=... npx tsx parity/record.ts --name review-pi-claude \
 *     --prompt "Review this codebase ..." [--model claude-sonnet-5-5] [--ref HEAD] [--repo .]
 *
 * Any Anthropic-compatible upstream works, e.g. a translating proxy serving other models:
 *   NODE_USE_ENV_PROXY=1 npx tsx parity/record.ts --upstream https://proxy.example --upstream-model gpt-5.6-sol ...
 * (--upstream-model is what the upstream receives; Claude Code itself is told --model.)
 *
 * Writes parity/recordings/<name>.json; `npx tsx parity/run.ts --only <name>` then replays the
 * recorded model turns against both Claude Code and pi-claude.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCommit } from "./fixture.js";
import { MockAnthropicServer } from "./mock-server.js";
import type { Recording } from "./recording.js";
import { recordingToScenario } from "./recording.js";
import { runClaude } from "./runners/claude-sdk.js";

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const name = arg("name");
const prompt = arg("prompt");
if (!name || !prompt) throw new Error("usage: record.ts --name <name> --prompt <prompt> [--model m] [--ref HEAD] [--repo .] [--description d]");
const upstream = arg("upstream");
const upstreamModel = arg("upstream-model");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey && !upstream) throw new Error("ANTHROPIC_API_KEY is required for recording (or pass --upstream for a proxy that injects credentials)");
const model = arg("model") ?? "claude-sonnet-5-5";
const repo = resolve(arg("repo") ?? ".");
const packageRoot = resolve(import.meta.dirname, "..");
// store this package's own repo as "." so recordings replay on any checkout
const fixture = { repo: repo === packageRoot ? "." : repo, commit: resolveCommit(repo, arg("ref") ?? "HEAD") };

const mock = new MockAnthropicServer();
const baseUrl = await mock.start();
mkdirSync(join(import.meta.dirname, "recordings"), { recursive: true });
mock.startRecording({ apiKey, upstream, model: upstreamModel, liveFile: join(import.meta.dirname, "recordings", `${name}.raw.json`) });
const scenario = { ...recordingToScenario({ name, description: "", prompt, model, recordedAt: "", fixture, recordedCwd: "", conversations: [{ name: "main", turns: [], toolResults: [] }] }), maxTurns: Number(arg("max-turns") ?? 100) };
process.stderr.write(`recording ${name} with ${model} (fixture ${fixture.commit.slice(0, 7)})…\n`);
const outcome = await runClaude(scenario, mock, baseUrl, model);
await mock.stop();
if (outcome.error) process.stderr.write(`claude run ended with: ${outcome.error.slice(0, 500)}\n`);

// save the raw capture first, so a post-processing error never loses a (long, paid) recording
const dir = join(import.meta.dirname, "recordings");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${name}.raw.json`), JSON.stringify({ prompt, model, upstreamModel, fixture, cwd: outcome.cwd, conversations: [...mock.recording.values()] }));

// main conversation = the one whose first user message contains the prompt
const convs = [...mock.recording.values()];
const main = convs.find((c) => c.firstUser.includes(prompt));
if (!main) throw new Error("main conversation not found in recording");
const agentPrompts = convs.flatMap((c) => c.turns.flatMap((t) => (t?.content ?? []).filter((b) => b.type === "tool_use" && b.name === "Agent").map((b) => String(b.input?.prompt ?? ""))));
const subs = convs.filter((c) => c !== main);
// route replayed subagent requests by the full Agent prompt (workspace path templated as {{cwd}});
// the longest prompt contained in the child's first message wins
const matchFor = (firstUser: string) =>
	agentPrompts
		.filter((ap) => ap && firstUser.includes(ap))
		.sort((a, b) => b.length - a.length)[0]
		?.replaceAll(outcome.cwd, "{{cwd}}");
const unmatched = subs.filter((c) => !matchFor(c.firstUser)).length;
const matches = subs.map((c) => matchFor(c.firstUser)).filter(Boolean);
if (unmatched) process.stderr.write(`warning: ${unmatched} subagent conversation(s) have no matching Agent prompt and will not replay\n`);
if (new Set(matches).size !== matches.length) process.stderr.write("warning: several subagents share the same Agent prompt; replay routes them to the first\n");
const recording: Recording = {
	name,
	description: arg("description") ?? `Recorded session: ${prompt.slice(0, 120)}`,
	prompt,
	model: upstreamModel ? `${upstreamModel} (via ${upstream})` : model,
	recordedAt: new Date().toISOString(),
	fixture,
	recordedCwd: outcome.cwd,
	conversations: [
		{ name: "main", turns: main.turns.map((t) => t ?? null), toolResults: main.toolResults },
		...subs.map((c, i) => ({ name: `sub${i}`, match: matchFor(c.firstUser), firstUser: c.firstUser.replaceAll(outcome.cwd, "{{cwd}}"), turns: c.turns.map((t) => t ?? null), toolResults: c.toolResults })),
	],
};
const file = join(dir, `${name}.json`);
writeFileSync(file, JSON.stringify(recording, null, 2));
const calls = recording.conversations.reduce((n, c) => n + c.turns.reduce((m, t) => m + (t?.content.filter((b) => b.type === "tool_use").length ?? 0), 0), 0);
process.stderr.write(`saved ${file}: ${recording.conversations.length} conversation(s), ${calls} tool calls, ${outcome.durationMs}ms\n`);
const last = main.turns.at(-1)?.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
if (last) writeFileSync(join(dir, `${name}.final.md`), last);
