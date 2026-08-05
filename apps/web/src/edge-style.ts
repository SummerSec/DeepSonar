/** Edge type only controls stroke pattern and flow speed; color comes from source node. */
export const EDGE_STYLE: Record<string, { dash: string; speed: string }> = {
  child: { dash: "", speed: "4.8s" },
  produces: { dash: "6 3", speed: "2.8s" },
  verifies: { dash: "2 3", speed: "1.8s" },
  next: { dash: "10 4 2 4", speed: "2.2s" },
  from: { dash: "4 4", speed: "3.2s" },
  to: { dash: "1 4", speed: "2.5s" },
};
