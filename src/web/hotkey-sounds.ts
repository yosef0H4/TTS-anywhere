import type { HotkeySoundId } from "../core/models/types";
import abortSoftThudUrl from "../assets/sfx/abort_soft_thud.ogg";
import captureFullChimeUrl from "../assets/sfx/capture_full_chime.ogg";
import captureStartSoftUrl from "../assets/sfx/capture_start_soft.ogg";
import captureWindowFocusUrl from "../assets/sfx/capture_window_focus.ogg";
import clipboardCaptureSoftUrl from "../assets/sfx/clipboard_capture_soft.ogg";
import copyPlayConfirmUrl from "../assets/sfx/copy_play_confirm.ogg";
import errorDoubleBuzzUrl from "../assets/sfx/error_double_buzz.ogg";
import playPauseToggleUrl from "../assets/sfx/play_pause_toggle.ogg";
import replayCaptureEchoUrl from "../assets/sfx/replay_capture_echo.ogg";
import seekNextTickUrl from "../assets/sfx/seek_next_tick.ogg";
import seekPreviousTickUrl from "../assets/sfx/seek_previous_tick.ogg";
import volumeDownFallUrl from "../assets/sfx/volume_down_fall.ogg";
import volumeUpRiseUrl from "../assets/sfx/volume_up_rise.ogg";

export const HOTKEY_SOUND_OPTIONS: HotkeySoundId[] = [
  "capture_start_soft",
  "clipboard_capture_soft",
  "capture_full_chime",
  "capture_window_focus",
  "copy_play_confirm",
  "abort_soft_thud",
  "play_pause_toggle",
  "seek_next_tick",
  "seek_previous_tick",
  "volume_up_rise",
  "volume_down_fall",
  "replay_capture_echo",
  "error_double_buzz"
];

export const HOTKEY_SOUND_URLS: Record<HotkeySoundId, string> = {
  capture_start_soft: captureStartSoftUrl,
  clipboard_capture_soft: clipboardCaptureSoftUrl,
  capture_full_chime: captureFullChimeUrl,
  capture_window_focus: captureWindowFocusUrl,
  copy_play_confirm: copyPlayConfirmUrl,
  abort_soft_thud: abortSoftThudUrl,
  play_pause_toggle: playPauseToggleUrl,
  seek_next_tick: seekNextTickUrl,
  seek_previous_tick: seekPreviousTickUrl,
  volume_up_rise: volumeUpRiseUrl,
  volume_down_fall: volumeDownFallUrl,
  replay_capture_echo: replayCaptureEchoUrl,
  error_double_buzz: errorDoubleBuzzUrl
};
