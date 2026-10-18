import type { Scenario } from "../types.js";
import { agentScenarios } from "./agents.js";
import { execScenarios } from "./exec.js";
import { fileScenarios } from "./files.js";

export const scenarios: Scenario[] = [...fileScenarios, ...execScenarios, ...agentScenarios];
