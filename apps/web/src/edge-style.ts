/** Edge type only controls stroke pattern and flow speed; color comes from source node. */
export const EDGE_STYLE: Record<string, { dash: string; speed: string }> = {
  child: { dash: "", speed: "4.8s" },
  produces: { dash: "8 4", speed: "2.8s" },
  verifies: { dash: "3 4", speed: "1.8s" },
  reviewed_by: { dash: "8 4", speed: "2.2s" },
  tested_by: { dash: "3 4", speed: "1.8s" },
  next: { dash: "10 4 3 4", speed: "2.2s" },
  from: { dash: "5 4", speed: "3.2s" },
  to: { dash: "3 4", speed: "2.5s" },
};
