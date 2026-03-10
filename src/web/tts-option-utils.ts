export interface NamedOptionLike {
  value: string;
  label: string;
}

export type VoiceListQuery = Record<string, string | undefined> & {
  model?: string;
};

export function makeOptionCacheKey(namespace: string, baseUrl: string, apiKey: string, discriminator = ""): string {
  return `${namespace}|${baseUrl.trim()}|${apiKey.trim()}|${discriminator.trim()}`;
}

export function joinApiPath(baseUrl: string, path: string, query: Record<string, string | undefined> = {}): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const requestUrl = `${normalized}${safePath}`;
  const url = new URL(requestUrl, "http://localhost");
  Object.entries(query).forEach(([key, value]) => {
    const trimmed = value?.trim();
    if (trimmed) {
      url.searchParams.set(key, trimmed);
    }
  });
  if (url.origin === "http://localhost") {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

export function resolveVoiceSelection(preferredVoice: string, options: NamedOptionLike[]): string {
  if (options.length === 0) {
    return preferredVoice;
  }
  if (preferredVoice && options.some((voice) => voice.value === preferredVoice)) {
    return preferredVoice;
  }
  return options[0]?.value ?? preferredVoice;
}
