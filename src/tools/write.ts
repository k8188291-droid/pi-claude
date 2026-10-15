import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CCContext } from "../shared/context.js";
import { resolvePath } from "../shared/paths.js";

const DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

const writeSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to write (must be absolute, not relative)" }),
		content: Type.String({ description: "The content to write to the file" }),
	},
	{ additionalProperties: false },
);

export interface WriteToolDetails {
	filePath: string;
	type: "create" | "update";
	bytes: number;
}

export function registerWrite(pi: ExtensionAPI, cc: CCContext): void {
	pi.registerTool({
		name: "Write",
		label: "Write",
		description: DESCRIPTION,
		promptSnippet: "Create or overwrite files",
		parameters: writeSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WriteToolDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (typeof params.file_path !== "string" || params.file_path.trim() === "") throw new Error("file_path is required.");
			if (typeof params.content !== "string") throw new Error("content must be a string.");
			const absPath = resolvePath(ctx?.cwd ?? process.cwd(), params.file_path);

			return withFileMutationQueue(absPath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const problem = cc.fileState.checkCanModify(absPath);
				if (problem) throw new Error(problem);

				let existed = false;
				try {
					const st = await stat(absPath);
					if (st.isDirectory()) throw new Error(`${absPath} is a directory.`);
					existed = true;
				} catch (err: any) {
					if (err?.code !== "ENOENT") throw err;
				}
				await mkdir(dirname(absPath), { recursive: true });
				if (signal?.aborted) throw new Error("Operation aborted");
				const data = Buffer.from(params.content, "utf8");
				await writeFile(absPath, data);
				cc.fileState.recordWrite(absPath, data);

				const text = existed
					? `The file ${absPath} has been updated successfully.`
					: `File created successfully at: ${absPath}`;
				return {
					content: [{ type: "text", text }],
					details: { filePath: absPath, type: existed ? "update" : "create", bytes: data.length },
				};
			});
		},
	});
}
