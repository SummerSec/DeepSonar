export interface SelectOption {
  value: string;
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

function searchableText(option: SelectOption): string {
  return [option.label, option.value, ...(option.keywords ?? [])].join(" ").toLowerCase();
}

export function filterSelectOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => searchableText(option).includes(needle));
}

export function toggleMultiValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function readMultiSearchParam(params: URLSearchParams, key: string): string[] {
  return [...new Set(params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

export function writeMultiSearchParam(params: URLSearchParams, key: string, values: readonly string[]): void {
  params.delete(key);
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length) params.set(key, unique.join(","));
}
