interface PanelResizerOptions {
  shell: HTMLElement;
  handle: HTMLElement;
  initialPercent: number;
  minPercent?: number;
  maxPercent?: number;
  onChange?: (percent: number) => void;
}

export class PanelResizer {
  private dragging = false;
  private readonly minPercent: number;
  private readonly maxPercent: number;
  private currentPercent: number;

  constructor(private readonly options: PanelResizerOptions) {
    this.minPercent = options.minPercent ?? 20;
    this.maxPercent = options.maxPercent ?? 70;
    this.currentPercent = this.clamp(options.initialPercent);

    this.apply();
    this.options.handle.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
    this.options.handle.addEventListener("dblclick", this.onDoubleClick);
  }

  dispose(): void {
    this.options.handle.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.options.handle.removeEventListener("dblclick", this.onDoubleClick);
  }

  private onMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    this.dragging = true;
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging) return;
    const rect = this.options.shell.getBoundingClientRect();
    const percent = ((event.clientX - rect.left) / rect.width) * 100;
    this.currentPercent = this.clamp(percent);
    this.apply();
    this.options.onChange?.(this.currentPercent);
  };

  private onMouseUp = (): void => {
    this.dragging = false;
  };

  private onDoubleClick = (): void => {
    this.currentPercent = 35;
    this.apply();
    this.options.onChange?.(this.currentPercent);
  };

  private apply(): void {
    this.options.shell.style.setProperty("--left-panel-width", `${this.currentPercent}%`);
  }

  private clamp(value: number): number {
    return Math.max(this.minPercent, Math.min(this.maxPercent, value));
  }
}
