export interface LaneHandle {
  signal: AbortSignal;
  token: number;
  done: () => void;
}

type LaneState = {
  token: number;
  controller: AbortController | null;
  parentAbort: (() => void) | null;
  parentSignal: AbortSignal | null;
};

export class RequestPreemptor<Lane extends string> {
  private readonly lanes = new Map<Lane, LaneState>();

  preemptLane(lane: Lane): void {
    const state = this.ensureLane(lane);
    this.disposeLaneController(state);
    state.token += 1;
  }

  preemptAll(): void {
    for (const lane of this.lanes.keys()) {
      this.preemptLane(lane);
    }
  }

  beginLane(lane: Lane, parentSignal?: AbortSignal): LaneHandle {
    this.preemptLane(lane);
    const state = this.ensureLane(lane);
    const controller = new AbortController();
    state.controller = controller;
    state.parentSignal = parentSignal ?? null;

    if (parentSignal) {
      const onAbort = (): void => {
        controller.abort();
      };
      state.parentAbort = onAbort;
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener("abort", onAbort);
      }
    }

    const laneToken = state.token;
    return {
      signal: controller.signal,
      token: laneToken,
      done: () => {
        const latest = this.lanes.get(lane);
        if (!latest || latest.token !== laneToken) return;
        this.disposeLaneController(latest);
      }
    };
  }

  isCurrent(lane: Lane, token: number): boolean {
    const state = this.lanes.get(lane);
    return Boolean(state && state.token === token);
  }

  private ensureLane(lane: Lane): LaneState {
    const existing = this.lanes.get(lane);
    if (existing) return existing;
    const created: LaneState = { token: 0, controller: null, parentAbort: null, parentSignal: null };
    this.lanes.set(lane, created);
    return created;
  }

  private disposeLaneController(state: LaneState): void {
    state.controller?.abort();
    state.controller = null;
    if (state.parentAbort && state.parentSignal) {
      state.parentSignal.removeEventListener("abort", state.parentAbort);
    }
    state.parentAbort = null;
    state.parentSignal = null;
  }
}
