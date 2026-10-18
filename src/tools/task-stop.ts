import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { textResult } from "../shared/text.js";

/** TaskStop: stops a background bash command or agent (Claude Code's replacement for KillShell). */
export function registerTaskStop(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description: `- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
		promptSnippet: "Stop a running background task (bash command or agent) by ID",
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
			shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
		}),
		async execute(_toolCallId, params) {
			const id = params.task_id ?? params.shell_id;
			if (!id) throw new Error("task_id is required");
			const task = await cc.tasks.stop(id);
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
