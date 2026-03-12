import { DEFAULT_CONFIG } from "../models/defaults";
import { resolveUiLanguage } from "../models/locale";
import type { AppConfig, BaseUiTheme, GeminiSdkLlmSettings, GeminiSdkTtsSettings, OpenAiCompatibleLlmSettings, OpenAiCompatibleTtsSettings } from "../models/types";

export const SETTINGS_KEY = "tts-anywhere:settings";
export const LEGACY_SETTINGS_KEYS = ["tts-snipper:settings"] as const;

export class SettingsStore {
  load(): AppConfig {
    const raw = localStorage.getItem(SETTINGS_KEY)
      ?? LEGACY_SETTINGS_KEYS.map((key) => localStorage.getItem(key)).find((value) => typeof value === "string")
      ?? null;
    if (!raw) return this.cloneDefaults();
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const migratedPanels = this.mergePanels(parsed.ui?.panels);
      const migratedTextProcessing = this.mergeTextProcessing(parsed.textProcessing);
      return {
        llm: this.mergeLlm(parsed.llm),
        tts: this.mergeTts(parsed.tts),
        reading: { ...DEFAULT_CONFIG.reading, ...parsed.reading },
        ui: {
          ...DEFAULT_CONFIG.ui,
          ...parsed.ui,
          theme: this.readUiTheme(parsed.ui?.theme, DEFAULT_CONFIG.ui.theme),
          darkMode: this.readBoolean(parsed.ui?.darkMode, DEFAULT_CONFIG.ui.darkMode),
          language: parsed.ui?.language === "ar" || parsed.ui?.language === "en" ? parsed.ui.language : resolveUiLanguage(),
          panels: migratedPanels
        },
        system: {
          ...DEFAULT_CONFIG.system,
          ...parsed.system,
          feedbackSounds: this.mergeFeedbackSounds(parsed.system?.feedbackSounds)
        },
        logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
        textProcessing: migratedTextProcessing,
        preprocessing: {
          ...DEFAULT_CONFIG.preprocessing,
          ...parsed.preprocessing,
          detectionFilter: {
            ...DEFAULT_CONFIG.preprocessing.detectionFilter,
            ...parsed.preprocessing?.detectionFilter
          },
          merge: {
            ...DEFAULT_CONFIG.preprocessing.merge,
            ...parsed.preprocessing?.merge
          },
          sorting: {
            ...DEFAULT_CONFIG.preprocessing.sorting,
            ...parsed.preprocessing?.sorting
          },
          selection: {
            ...DEFAULT_CONFIG.preprocessing.selection,
            ...parsed.preprocessing?.selection,
            ops: parsed.preprocessing?.selection?.ops ?? DEFAULT_CONFIG.preprocessing.selection.ops,
            manualBoxes: parsed.preprocessing?.selection?.manualBoxes ?? DEFAULT_CONFIG.preprocessing.selection.manualBoxes
          }
        }
      };
    } catch {
      return this.cloneDefaults();
    }
  }

  save(next: AppConfig): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    for (const legacyKey of LEGACY_SETTINGS_KEYS) {
      localStorage.removeItem(legacyKey);
    }
  }

  private mergePanels(panels: unknown): AppConfig["ui"]["panels"] {
    const defaults = DEFAULT_CONFIG.ui.panels;
    if (!panels || typeof panels !== "object") {
      return defaults;
    }

    const value = panels as Record<string, unknown>;
    const desktop = (value.desktop as Record<string, unknown> | undefined) ?? {};
    const mobile = (value.mobile as Record<string, unknown> | undefined) ?? {};
    const collapsed = (mobile.collapsed as Record<string, unknown> | undefined) ?? {};

    const legacyImageWidth = this.readNumber(value.imagePanelWidthPercent, defaults.desktop.leftPanePercent);

    return {
      desktop: {
        leftPanePercent: this.readNumber(desktop.leftPanePercent, legacyImageWidth),
        rightTopPercent: this.readNumber(desktop.rightTopPercent, defaults.desktop.rightTopPercent)
      },
      mobile: {
        imageHeightPercent: this.readNumber(mobile.imageHeightPercent, defaults.mobile.imageHeightPercent),
        editorHeightPercent: this.readNumber(mobile.editorHeightPercent, defaults.mobile.editorHeightPercent),
        previewHeightPercent: this.readNumber(mobile.previewHeightPercent, defaults.mobile.previewHeightPercent),
        collapsed: {
          image: this.readBoolean(collapsed.image, defaults.mobile.collapsed.image),
          editor: this.readBoolean(collapsed.editor, defaults.mobile.collapsed.editor),
          preview: this.readBoolean(collapsed.preview, defaults.mobile.collapsed.preview)
        }
      }
    };
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private readUiTheme(value: unknown, fallback: BaseUiTheme): BaseUiTheme {
    return value === "zen" || value === "pink" ? value : fallback;
  }

  private cloneDefaults(): AppConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  }

  private mergeFeedbackSounds(feedbackSounds: unknown): AppConfig["system"]["feedbackSounds"] {
    const defaults = DEFAULT_CONFIG.system.feedbackSounds;
    if (!feedbackSounds || typeof feedbackSounds !== "object") {
      return JSON.parse(JSON.stringify(defaults)) as AppConfig["system"]["feedbackSounds"];
    }
    const value = feedbackSounds as {
      byHotkey?: Partial<Record<keyof typeof defaults.byHotkey, Partial<typeof defaults.byHotkey.capture>>>;
      globalError?: Partial<typeof defaults.globalError>;
    };
    return {
      byHotkey: {
        capture: { ...defaults.byHotkey.capture, ...value.byHotkey?.capture },
        ocrClipboard: { ...defaults.byHotkey.ocrClipboard, ...value.byHotkey?.ocrClipboard },
        fullCapture: { ...defaults.byHotkey.fullCapture, ...value.byHotkey?.fullCapture },
        activeWindowCapture: { ...defaults.byHotkey.activeWindowCapture, ...value.byHotkey?.activeWindowCapture },
        copyPlay: { ...defaults.byHotkey.copyPlay, ...value.byHotkey?.copyPlay },
        abort: { ...defaults.byHotkey.abort, ...value.byHotkey?.abort },
        playPause: { ...defaults.byHotkey.playPause, ...value.byHotkey?.playPause },
        nextChunk: { ...defaults.byHotkey.nextChunk, ...value.byHotkey?.nextChunk },
        previousChunk: { ...defaults.byHotkey.previousChunk, ...value.byHotkey?.previousChunk },
        volumeUp: { ...defaults.byHotkey.volumeUp, ...value.byHotkey?.volumeUp },
        volumeDown: { ...defaults.byHotkey.volumeDown, ...value.byHotkey?.volumeDown },
        replayCapture: { ...defaults.byHotkey.replayCapture, ...value.byHotkey?.replayCapture }
      },
      globalError: { ...defaults.globalError, ...value.globalError }
    };
  }

  private mergeLlm(llm: unknown): AppConfig["llm"] {
    const defaults = DEFAULT_CONFIG.llm;
    if (!llm || typeof llm !== "object") {
      return { ...defaults, openaiCompatible: { ...defaults.openaiCompatible }, geminiSdk: { ...defaults.geminiSdk } };
    }

    const value = llm as Record<string, unknown>;
    const openaiCompatible: OpenAiCompatibleLlmSettings = {
      ...defaults.openaiCompatible,
      ...((value.openaiCompatible as Partial<OpenAiCompatibleLlmSettings> | undefined) ?? {})
    };
    const geminiSdk: GeminiSdkLlmSettings = {
      ...defaults.geminiSdk,
      ...((value.geminiSdk as Partial<GeminiSdkLlmSettings> | undefined) ?? {})
    };
    const legacyFlat = value as Partial<OpenAiCompatibleLlmSettings>;
    const migratedProvider = value.provider === "gemini_sdk" || value.provider === "openai_compatible"
      ? value.provider
      : "openai_compatible";

    if (!value.openaiCompatible) {
      Object.assign(openaiCompatible, {
        baseUrl: typeof legacyFlat.baseUrl === "string" ? legacyFlat.baseUrl : openaiCompatible.baseUrl,
        apiKey: typeof legacyFlat.apiKey === "string" ? legacyFlat.apiKey : openaiCompatible.apiKey,
        model: typeof legacyFlat.model === "string" ? legacyFlat.model : openaiCompatible.model,
        promptTemplate: typeof legacyFlat.promptTemplate === "string" ? legacyFlat.promptTemplate : openaiCompatible.promptTemplate,
        imageDetail: legacyFlat.imageDetail === "high" || legacyFlat.imageDetail === "low" ? legacyFlat.imageDetail : openaiCompatible.imageDetail,
        ocrStreamingEnabled: typeof legacyFlat.ocrStreamingEnabled === "boolean" ? legacyFlat.ocrStreamingEnabled : openaiCompatible.ocrStreamingEnabled,
        ocrStreamingFallbackToNonStream: typeof legacyFlat.ocrStreamingFallbackToNonStream === "boolean" ? legacyFlat.ocrStreamingFallbackToNonStream : openaiCompatible.ocrStreamingFallbackToNonStream,
        maxTokens: typeof legacyFlat.maxTokens === "number" ? legacyFlat.maxTokens : openaiCompatible.maxTokens,
        thinkingMode: value.thinkingMode === "provider_default" || value.thinkingMode === "low" || value.thinkingMode === "off"
          ? value.thinkingMode
          : openaiCompatible.thinkingMode
      });
    }

    const active = migratedProvider === "gemini_sdk"
      ? {
          baseUrl: defaults.baseUrl,
          apiKey: geminiSdk.apiKey,
          model: geminiSdk.model,
          promptTemplate: geminiSdk.promptTemplate,
          imageDetail: geminiSdk.imageDetail,
          ocrStreamingEnabled: geminiSdk.ocrStreamingEnabled,
          ocrStreamingFallbackToNonStream: geminiSdk.ocrStreamingFallbackToNonStream,
          maxTokens: geminiSdk.maxTokens,
          thinkingMode: geminiSdk.thinkingMode
        }
      : {
          baseUrl: openaiCompatible.baseUrl,
          apiKey: openaiCompatible.apiKey,
          model: openaiCompatible.model,
          promptTemplate: openaiCompatible.promptTemplate,
          imageDetail: openaiCompatible.imageDetail,
          ocrStreamingEnabled: openaiCompatible.ocrStreamingEnabled,
          ocrStreamingFallbackToNonStream: openaiCompatible.ocrStreamingFallbackToNonStream,
          maxTokens: openaiCompatible.maxTokens,
          thinkingMode: openaiCompatible.thinkingMode
        };

    return {
      ...defaults,
      ...active,
      provider: migratedProvider,
      openaiCompatible,
      geminiSdk
    };
  }

  private mergeTts(tts: unknown): AppConfig["tts"] {
    const defaults = DEFAULT_CONFIG.tts;
    if (!tts || typeof tts !== "object") {
      return { ...defaults, openaiCompatible: { ...defaults.openaiCompatible }, geminiSdk: { ...defaults.geminiSdk } };
    }

    const value = tts as Record<string, unknown>;
    const openaiCompatible: OpenAiCompatibleTtsSettings = {
      ...defaults.openaiCompatible,
      ...((value.openaiCompatible as Partial<OpenAiCompatibleTtsSettings> | undefined) ?? {})
    };
    const geminiSdk: GeminiSdkTtsSettings = {
      ...defaults.geminiSdk,
      ...((value.geminiSdk as Partial<GeminiSdkTtsSettings> | undefined) ?? {})
    };
    const legacyFlat = value as Partial<OpenAiCompatibleTtsSettings>;
    const migratedProvider = value.provider === "gemini_sdk" || value.provider === "openai_compatible"
      ? value.provider
      : "openai_compatible";

    if (!value.openaiCompatible) {
      Object.assign(openaiCompatible, {
        baseUrl: typeof legacyFlat.baseUrl === "string" ? legacyFlat.baseUrl : openaiCompatible.baseUrl,
        apiKey: typeof legacyFlat.apiKey === "string" ? legacyFlat.apiKey : openaiCompatible.apiKey,
        model: typeof legacyFlat.model === "string" ? legacyFlat.model : openaiCompatible.model,
        voice: typeof legacyFlat.voice === "string" ? legacyFlat.voice : openaiCompatible.voice,
        format: legacyFlat.format === "mp3" || legacyFlat.format === "wav" || legacyFlat.format === "opus" ? legacyFlat.format : openaiCompatible.format,
        speed: typeof legacyFlat.speed === "number" ? legacyFlat.speed : openaiCompatible.speed,
        thinkingMode: value.thinkingMode === "provider_default" || value.thinkingMode === "low" || value.thinkingMode === "off"
          ? value.thinkingMode
          : openaiCompatible.thinkingMode
      });
    }

    const active = migratedProvider === "gemini_sdk"
      ? {
          baseUrl: defaults.baseUrl,
          apiKey: geminiSdk.apiKey,
          model: geminiSdk.model,
          voice: geminiSdk.voice,
          format: geminiSdk.format,
          speed: geminiSdk.speed,
          thinkingMode: geminiSdk.thinkingMode
        }
      : {
          baseUrl: openaiCompatible.baseUrl,
          apiKey: openaiCompatible.apiKey,
          model: openaiCompatible.model,
          voice: openaiCompatible.voice,
          format: openaiCompatible.format,
          speed: openaiCompatible.speed,
          thinkingMode: openaiCompatible.thinkingMode
        };

    return {
      ...defaults,
      ...active,
      provider: migratedProvider,
      openaiCompatible,
      geminiSdk
    };
  }

  private mergeTextProcessing(textProcessing: unknown): AppConfig["textProcessing"] {
    const defaults = DEFAULT_CONFIG.textProcessing;
    if (!textProcessing || typeof textProcessing !== "object") {
      return defaults;
    }

    const value = textProcessing as Record<string, unknown>;
    const detectionMode = value.detectionMode;
    const rapidMode = value.rapidMode;
    const legacyRapidEnabled = value.rapidEnabled;
    const detectorProvider = value.detectorProvider;
    const detectorBaseUrls = (value.detectorBaseUrls as Record<string, unknown> | undefined) ?? {};
    const explicitBaseUrl = typeof value.detectorBaseUrl === "string" && value.detectorBaseUrl.trim()
      ? value.detectorBaseUrl
      : null;
    const legacyRapidBaseUrl = typeof value.rapidBaseUrl === "string" && value.rapidBaseUrl.trim()
      ? value.rapidBaseUrl
      : defaults.detectorBaseUrl;
    const migratedProvider = detectorProvider === "rapid" || detectorProvider === "paddle"
      ? detectorProvider
      : "rapid";
    const migratedProviderUrl = typeof detectorBaseUrls[migratedProvider] === "string" && String(detectorBaseUrls[migratedProvider]).trim()
      ? String(detectorBaseUrls[migratedProvider]).trim()
      : null;

    return {
      detectionMode: detectionMode === "off" || detectionMode === "fullscreen_only" || detectionMode === "fullscreen_and_window" || detectionMode === "all"
        ? detectionMode
        : (rapidMode === "off" || rapidMode === "fullscreen_only" || rapidMode === "fullscreen_and_window" || rapidMode === "all"
            ? rapidMode
            : (legacyRapidEnabled === true ? "all" : defaults.detectionMode)),
      detectorBaseUrl: explicitBaseUrl ?? migratedProviderUrl ?? legacyRapidBaseUrl
    };
  }
}
