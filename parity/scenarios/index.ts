import type { Scenario } from "../types.js";
import { agentScenarios } from "./agents.js";
import { editScenarios } from "./edit.js";
import { execScenarios } from "./exec.js";
import { readScenarios } from "./read.js";
import { searchScenarios } from "./search.js";
import { taskScenarios } from "./tasks.js";

export const scenarios: Scenario[] = [...readScenarios, ...editScenarios, ...searchScenarios, ...execScenarios, ...agentScenarios, ...taskScenarios];
