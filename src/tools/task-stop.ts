import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { textResult } from "../shared/text.js";
import { claudeInputValidator, type Spec } from "./input-validation.js";

const TaskStopSpec: Spec = {
	kind: "object",
	strict: true,
	props: { task_id: { spec: { kind: "string" }, optional: true }, shell_id: { spec: { kind: "string" }, optional: true } },
};

const TASK_STOP_DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop an agent-team teammate, pass its agent ID or bare teammate name as task_id
- To stop a background agent spawned with a name, pass that name as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`;

/** Claude Code reports input-validation failures wrapped in <tool_use_error>. */
const validationError = (message: string) => new Error(`<tool_use_error>${message}</tool_use_error>`);

/** TaskStop: stops a background bash command or agent (Claude Code's replacement for KillShell). */
export function registerTaskStop(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description: TASK_STOP_DESCRIPTION,
		promptSnippet: "Stop a running background task (bash command or agent) by ID",
		parameters: Type.Object(
			{
				task_id: Type.Optional(
					Type.String({
						description:
							"The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.",
					}),
				),
				shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
			},
			{ additionalProperties: false },
		),
		prepareArguments: claudeInputValidator<{ task_id?: string; shell_id?: string }>("TaskStop", TaskStopSpec) as any,
		async execute(_toolCallId, params) {
			const id = params.task_id ?? params.shell_id;
			if (!id) throw validationError("Missing required parameter: task_id");
			const task = cc.tasks.get(id);
			// Claude Code drops finished tasks from its registry once their completion is reported.
			if (!task || task.status !== "running") throw validationError(`No task found with ID: ${id}`);
			await cc.tasks.stop(id);
			return textResult(
				JSON.stringify({ message: `Successfully stopped task: ${task.id} (${task.label})`, task_id: task.id, task_type: task.type, command: task.label }),
				{ taskId: task.id, taskType: task.type },
			);
		},
	});
	pi.on("session_shutdown", async () => {
		await cc.tasks.stopAll();
	});
}
