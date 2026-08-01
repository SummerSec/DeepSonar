export const STATUS_COLOR: Record<string, string> = {
  active: "#6fbbe8", running: "#6fbbe8", claimed: "#6fbbe8", provisioning: "#6fbbe8", generating: "#6fbbe8", reporting: "#6fbbe8", verifying: "#6fbbe8",
  succeeded: "#65e6b4", confirmed: "#65e6b4", verified: "#65e6b4", analysis_complete: "#65e6b4",
  pending: "#7f8796", unverified: "#7f8796", cancelled: "#7f8796", false_positive: "#7f8796",
  open: "#e8bd70", needs_human: "#e8bd70", waiting_human: "#e8bd70",
  failed: "#ed6a7f", rejected: "#ed6a7f", timeout: "#ed6a7f", orphan: "#ed6a7f",
};

export const SEVERITY_COLOR: Record<string, string> = { low: "#7f8796", medium: "#e8bd70", high: "#ec8c5d", critical: "#ed6a7f" };

export const VERIFICATION_META: Record<string, { label: string; color: string }> = {
  unverified: { label: "待验证", color: "#7f8796" },
  verifying: { label: "验证中", color: "#6fbbe8" },
  verified: { label: "已验证", color: "#65e6b4" },
  rejected: { label: "已排除", color: "#ed6a7f" },
  needs_human: { label: "待人工", color: "#e8bd70" },
};
