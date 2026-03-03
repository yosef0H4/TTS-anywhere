declare module "screenshot-desktop" {
  export type ScreenshotOptions = { format?: "png" | "jpg" };
  export default function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
}
