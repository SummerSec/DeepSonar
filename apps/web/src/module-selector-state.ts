import {
  parseModuleSelector,
  type ParsedModuleSelector,
} from "@deepsonar/shared-types";
import type { SourceModuleEntry } from "./api";

export interface ModulePickerOption extends SourceModuleEntry {
  key: string;
  sourceId: string;
  sourceName: string;
}

export interface ModulePickerPluginGroup {
  sourceId: string;
  sourceName: string;
  plugin: string;
  selector: string;
  options: ModulePickerOption[];
}

export function moduleSelectorFor(sourceId: string, moduleId: string): string {
  return `${sourceId}:${moduleId}`;
}

export function pluginSelectorFor(sourceId: string, plugin: string): string {
  return `${sourceId}:plugin:${plugin}`;
}

export function sourceSelectorFor(sourceId: string): string {
  return `${sourceId}:source:*`;
}

function parsed(value: string): ParsedModuleSelector | null {
  try {
    return parseModuleSelector(value);
  } catch {
    return null;
  }
}

/** 比较 selector 的规范形式，但始终把用户原始字符串写回表单。 */
export function selectorIsActive(selected: string[], selector: string): boolean {
  const target = parsed(selector);
  return selected.some((value) => {
    const current = parsed(value);
    return target && current ? target.canonical === current.canonical : value === selector;
  });
}

/** 组选择器取消时只移除该 selector，不删除独立勾选的 module。 */
export function toggleSelector(selected: string[], selector: string): string[] {
  if (selectorIsActive(selected, selector)) {
    const target = parsed(selector);
    return selected.filter((value) => {
      const current = parsed(value);
      return target && current ? target.canonical !== current.canonical : value !== selector;
    });
  }
  return [...selected, selector];
}

export function toggleExplicitModule(selected: string[], sourceId: string, moduleId: string): string[] {
  return toggleSelector(selected, moduleSelectorFor(sourceId, moduleId));
}

/** 当前行是否由显式 module、plugin selector 或 source selector 覆盖。 */
export function moduleIsIncluded(option: ModulePickerOption, selected: string[]): boolean {
  const direct = moduleSelectorFor(option.sourceId, option.id);
  if (selectorIsActive(selected, direct)) return true;
  return selected.some((value) => {
    const selector = parsed(value);
    if (!selector || selector.source_id !== option.sourceId) return false;
    return selector.kind === "source" || (selector.kind === "plugin" && selector.plugin === option.plugin);
  });
}

/** 将 catalog 按 source → plugin 分组，root 也作为合法 plugin 组展示。 */
export function groupModuleOptions(options: ModulePickerOption[]): ModulePickerPluginGroup[] {
  const groups = new Map<string, ModulePickerPluginGroup>();
  for (const option of options) {
    const key = `${option.sourceId}:${option.plugin}`;
    const group = groups.get(key) ?? {
      sourceId: option.sourceId,
      sourceName: option.sourceName,
      plugin: option.plugin,
      selector: pluginSelectorFor(option.sourceId, option.plugin),
      options: [],
    };
    group.options.push(option);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => `${a.sourceName}/${a.plugin}`.localeCompare(`${b.sourceName}/${b.plugin}`));
}

export function sourceHasSelector(selected: string[], sourceId: string): boolean {
  return selectorIsActive(selected, sourceSelectorFor(sourceId));
}
