export const ACCENT_THEME_STORAGE_KEY = "deepsonar:accent-theme";

export const ACCENT_THEMES = [
  { id: "mint", label: "翡翠夜幕", caption: "默认深色精密仪器", color: "#65e6b4", surface: "#0b0e10", scheme: "dark" },
  { id: "arctic", label: "极地蓝", caption: "冷静深色技术界面", color: "#78bfff", surface: "#0b0e10", scheme: "dark" },
  { id: "lime", label: "荧光青柠", caption: "高对比深色作业台", color: "#b8df68", surface: "#0b0e10", scheme: "dark" },
  { id: "titanium", label: "钛金属", caption: "低彩度深色专注模式", color: "#c6d0d5", surface: "#0b0e10", scheme: "dark" },
  { id: "porcelain", label: "瓷白日光", caption: "暖白亮色工作台", color: "#087a63", surface: "#f3f1ec", scheme: "light" },
  { id: "mist", label: "雾白纸台", caption: "略沉冷白 · 比瓷白更收敛", color: "#3d6b8a", surface: "#e4e7ec", scheme: "light" },
  { id: "open-kritt", label: "open-kritt", caption: "暖白画布 · 珊瑚橙强调", color: "#c04326", surface: "#fbfbfa", scheme: "light" },
] as const;

export type AccentTheme = (typeof ACCENT_THEMES)[number]["id"];

export function resolveAccentTheme(stored: string | null | undefined): AccentTheme {
  return ACCENT_THEMES.some((theme) => theme.id === stored) ? stored as AccentTheme : "mint";
}

export function accentThemeById(id: AccentTheme) {
  return ACCENT_THEMES.find((theme) => theme.id === id) ?? ACCENT_THEMES[0];
}
