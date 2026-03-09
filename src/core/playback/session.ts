export interface PlaybackResumeState {
  chunkPlaybackMode: boolean;
  audioSrc: string;
  speakingChunkId: string | null;
}

export function canResumePlayback(state: PlaybackResumeState): boolean {
  return state.chunkPlaybackMode
    && state.audioSrc.length > 0
    && state.speakingChunkId !== null;
}
