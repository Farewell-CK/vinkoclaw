import { evaluateGoalRunRouting } from "./inbound-policy-engine.js";

export function shouldRouteToGoalRun(text: string): boolean {
  return evaluateGoalRunRouting(text).intent === "goalrun";
}
