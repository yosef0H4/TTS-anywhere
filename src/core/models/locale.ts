export type UiLanguage = "en" | "ar";

function normalizeLocale(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveUiLanguage(
  preferredLocales: readonly string[] | null | undefined = globalThis.navigator?.languages,
  fallbackLocale: string | null | undefined = globalThis.navigator?.language
): UiLanguage {
  const ordered = Array.isArray(preferredLocales) && preferredLocales.length > 0
    ? preferredLocales
    : (fallbackLocale ? [fallbackLocale] : []);

  for (const locale of ordered) {
    if (normalizeLocale(locale).startsWith("ar")) {
      return "ar";
    }
  }

  return "en";
}
