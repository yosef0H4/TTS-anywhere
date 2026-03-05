interface WorkspaceResizerOptions {
  shell: HTMLElement;
  verticalHandle: HTMLElement;
  horizontalHandle: HTMLElement;
  initialLeftPercent: number;
  initialRightTopPercent: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
  minRightTopPercent?: number;
  maxRightTopPercent?: number;
  onChange?: (layout: { leftPercent: number; rightTopPercent: number }) => void;
}

type Axis = "vertical" | "horizontal";

export class WorkspaceResizer {
  private draggingAxis: Axis | null = null;
  private leftPercent: number;
  private rightTopPercent: number;
  private readonly minLeftPercent: number;
  private readonly maxLeftPercent: number;
  private readonly minRightTopPercent: number;
  private readonly maxRightTopPercent: number;

  constructor(private readonly options: WorkspaceResizerOptions) {
    this.minLeftPercent = options.minLeftPercent ?? 20;
    this.maxLeftPercent = options.maxLeftPercent ?? 75;
    this.minRightTopPercent = options.minRightTopPercent ?? 20;
    this.maxRightTopPercent = options.maxRightTopPercent ?? 80;
    this.leftPercent = this.clamp(options.initialLeftPercent, this.minLeftPercent, this.maxLeftPercent);
    this.rightTopPercent = this.clamp(options.initialRightTopPercent, this.minRightTopPercent, this.maxRightTopPercent);

    this.apply();

    this.options.verticalHandle.addEventListener("pointerdown", this.onVerticalPointerDown);
    this.options.horizontalHandle.addEventListener("pointerdown", this.onHorizontalPointerDown);

    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerUp);

    this.options.verticalHandle.addEventListener("dblclick", this.onVerticalDoubleClick);
    this.options.horizontalHandle.addEventListener("dblclick", this.onHorizontalDoubleClick);
  }

  dispose(): void {
    this.options.verticalHandle.removeEventListener("pointerdown", this.onVerticalPointerDown);
    this.options.horizontalHandle.removeEventListener("pointerdown", this.onHorizontalPointerDown);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    this.options.verticalHandle.removeEventListener("dblclick", this.onVerticalDoubleClick);
    this.options.horizontalHandle.removeEventListener("dblclick", this.onHorizontalDoubleClick);
  }

  private onVerticalPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.draggingAxis = "vertical";
  };

  private onHorizontalPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.draggingAxis = "horizontal";
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.draggingAxis) {
      return;
    }

    if (this.draggingAxis === "vertical") {
      const rect = this.options.shell.getBoundingClientRect();
      const next = ((event.clientX - rect.left) / rect.width) * 100;
      this.leftPercent = this.clamp(next, this.minLeftPercent, this.maxLeftPercent);
    } else {
      const workspaceRight = this.options.shell.querySelector<HTMLElement>(".workspace-right");
      if (!workspaceRight) {
        return;
      }
      const rect = workspaceRight.getBoundingClientRect();
      const next = ((event.clientY - rect.top) / rect.height) * 100;
      this.rightTopPercent = this.clamp(next, this.minRightTopPercent, this.maxRightTopPercent);
    }

    this.apply();
    this.options.onChange?.({
      leftPercent: this.leftPercent,
      rightTopPercent: this.rightTopPercent
    });
  };

  private onPointerUp = (): void => {
    this.draggingAxis = null;
  };

  private onVerticalDoubleClick = (): void => {
    this.leftPercent = 38;
    this.apply();
    this.options.onChange?.({
      leftPercent: this.leftPercent,
      rightTopPercent: this.rightTopPercent
    });
  };

  private onHorizontalDoubleClick = (): void => {
    this.rightTopPercent = 55;
    this.apply();
    this.options.onChange?.({
      leftPercent: this.leftPercent,
      rightTopPercent: this.rightTopPercent
    });
  };

  private apply(): void {
    this.options.shell.style.setProperty("--workspace-left", `${this.leftPercent}%`);
    this.options.shell.style.setProperty("--workspace-right-top", `${this.rightTopPercent}%`);
    window.dispatchEvent(new CustomEvent("workspace:layout-change"));
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
