/**
 * Phase 1 numeric fidelity (#368): mechanical check of declared quantities.
 * Undeclared prose numbers are unprotected by design. No NL extraction.
 */
import { parseDeclaredQuantities, type QuantityAnchor } from "@deepsonar/shared-types";

export const NUMERIC_INCONSISTENT = "numeric_inconsistent";

export type QuantitySourceKind = "finding" | "fact";

export interface DeclaredQuantity extends QuantityAnchor {
  source: QuantitySourceKind;
  source_id: string;
}

export interface NumericFidelityFailure {
  source: QuantitySourceKind;
  source_id: string;
  value: number;
  unit: string;
  reason: "missing" | "folded";
}

export interface NumericFidelityResult {
  ok: boolean;
  code?: typeof NUMERIC_INCONSISTENT;
  failures: NumericFidelityFailure[];
}

export function formatQuantityLine(quantity: QuantityAnchor): string {
  const ref = quantity.ref ? `; ref=${quantity.ref}` : "";
  return `${quantity.value} ${quantity.unit} (basis: ${quantity.basis}${ref})`;
}

export function declaredQuantitiesFromPayloads(
  findings: ReadonlyArray<{ id: string; verify_status?: string; quantities?: unknown }>,
  facts: ReadonlyArray<{ id: string; verification_status?: string; quantities?: unknown }> = [],
): DeclaredQuantity[] {
  const declared: DeclaredQuantity[] = [];
  for (const finding of findings) {
    if (finding.verify_status !== "confirmed") continue;
    for (const quantity of parseDeclaredQuantities(finding.quantities)) {
      declared.push({ ...quantity, source: "finding", source_id: finding.id });
    }
  }
  for (const fact of facts) {
    if (fact.verification_status === "rejected") continue;
    for (const quantity of parseDeclaredQuantities(fact.quantities)) {
      declared.push({ ...quantity, source: "fact", source_id: fact.id });
    }
  }
  return declared;
}

function valueAppears(text: string, value: number): boolean {
  const token = String(value);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9.])${escaped}(?![0-9])`).test(text);
}

function corpusContains(text: string, fragment: string): boolean {
  return text.includes(fragment);
}

function checkOneCorpus(
  declared: readonly DeclaredQuantity[],
  text: string,
): NumericFidelityFailure[] {
  const failures: NumericFidelityFailure[] = [];
  for (const quantity of declared) {
    const hasValue = valueAppears(text, quantity.value);
    const hasUnit = corpusContains(text, quantity.unit);
    const hasBasis = corpusContains(text, quantity.basis);
    if (hasValue && hasUnit && hasBasis) continue;
    failures.push({
      source: quantity.source,
      source_id: quantity.source_id,
      value: quantity.value,
      unit: quantity.unit,
      reason: hasValue ? "folded" : "missing",
    });
  }
  return failures;
}

/**
 * Verify each declared value+unit+basis appears in report markdown.
 * When SARIF is present, confirmed-finding anchors must also appear there
 * (facts are markdown-only; SARIF only contains confirmed findings).
 */
export function checkReportNumericFidelity(
  declared: readonly DeclaredQuantity[],
  artifacts: { markdown: string; sarif?: string },
): NumericFidelityResult {
  if (declared.length === 0) return { ok: true, failures: [] };
  const findingAnchors = declared.filter((item) => item.source === "finding");
  const failures = [
    ...checkOneCorpus(declared, artifacts.markdown),
    ...(artifacts.sarif !== undefined ? checkOneCorpus(findingAnchors, artifacts.sarif) : []),
  ];
  const unique = new Map<string, NumericFidelityFailure>();
  for (const failure of failures) {
    const key = `${failure.source}:${failure.source_id}:${failure.value}:${failure.unit}:${failure.reason}`;
    if (!unique.has(key)) unique.set(key, failure);
  }
  const list = [...unique.values()];
  if (list.length === 0) return { ok: true, failures: [] };
  return { ok: false, code: NUMERIC_INCONSISTENT, failures: list };
}

export function numericInconsistentError(result: NumericFidelityResult): string {
  const details = result.failures
    .map((failure) => `${failure.reason} ${failure.source}=${failure.source_id} value=${failure.value} unit=${failure.unit}`)
    .join("; ");
  return details ? `${NUMERIC_INCONSISTENT}: ${details}` : NUMERIC_INCONSISTENT;
}
