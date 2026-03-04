# Manual Validation Checklist

## Inputs
- Upload path works for png/jpg/webp files.
- Clipboard paste (Ctrl+V) loads image successfully.

## Detection
- Detection runs and overlays boxes on image.
- Preprocessing sliders noticeably affect detection output.
- Metrics update after each run.

## Alignment
- Resizing window does not break box alignment.
- Boxes stay anchored correctly on different image sizes/aspect ratios.

## Robustness
- Invalid settings/image errors are surfaced in UI.
- Server unreachable state is visible via Health check.
