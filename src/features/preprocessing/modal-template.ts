export const PREPROCESS_MODAL_TEMPLATE = `
<div class="preproc-modal-backdrop" data-preproc-modal hidden style="display:none;pointer-events:none;">
  <div class="preproc-modal">
    <div class="preproc-modal-header">
      <div class="preproc-header-left">
        <i data-lucide="scan" class="ui-icon"></i>
        <h3>Preprocessing Lab</h3>
      </div>
      <button id="preproc-close" class="window-btn" title="Apply and close"><i data-lucide="check" class="ui-icon"></i></button>
    </div>
    <div class="preproc-modal-body">
      <aside class="preproc-sidebar">
        <section class="preproc-section">
          <div class="preproc-section-head">
            <i data-lucide="cpu" class="ui-icon"></i>
            <h4>RapidOCR</h4>
          </div>
          <div class="preproc-row">
            <label class="preproc-checkbox" title="Enable RapidOCR box detection from Python server">
              <input id="preproc-rapid-enabled" type="checkbox">
              <span>Enable OCR Detection</span>
            </label>
          </div>
          <div class="preproc-field">
            <label for="preproc-rapid-url">Server URL</label>
            <div class="preproc-input-row">
              <input id="preproc-rapid-url" type="text" placeholder="http://127.0.0.1:8091" title="RapidOCR service base URL" />
              <button id="preproc-rapid-health" class="window-btn" title="Check server health"><i data-lucide="activity" class="ui-icon"></i></button>
            </div>
          </div>
          <div id="preproc-health-status" class="preproc-hint"></div>
          <button id="preproc-detect-now" class="preproc-action-btn" title="Run rapid detection now">
            <i data-lucide="scan-search" class="ui-icon"></i>
            <span>Run Detection</span>
          </button>
        </section>

        <section class="preproc-section">
          <div class="preproc-section-head">
            <i data-lucide="sliders-horizontal" class="ui-icon"></i>
            <h4>Quality</h4>
          </div>
          <div class="viz-wrap"><canvas id="preproc-quality-viz" class="side-viz" width="320" height="60"></canvas></div>
          <div class="preproc-field">
            <label>Max Dimension <span id="preproc-max-dim-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-max-dim" type="range" min="360" max="3840" step="60" title="Resize image to this max dimension before OCR">
              <input id="preproc-max-dim-num" type="number" min="360" max="3840" step="60" class="control-num">
              <button id="preproc-max-dim-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>
        </section>

        <section class="preproc-section">
          <div class="preproc-section-head">
            <i data-lucide="mouse-pointer-2" class="ui-icon"></i>
            <h4>Selection Tools</h4>
          </div>
          <p class="preproc-hint">Add/Sub modifies selection mask; Manual creates deletable boxes.</p>
          <div class="preproc-tool-group">
            <button id="preproc-tool-none" class="preproc-tool-btn" title="View mode"><i data-lucide="eye" class="ui-icon"></i></button>
            <button id="preproc-tool-add" class="preproc-tool-btn" title="Draw add-area selection mask"><i data-lucide="plus-square" class="ui-icon"></i></button>
            <button id="preproc-tool-sub" class="preproc-tool-btn" title="Draw remove-area selection mask"><i data-lucide="minus-square" class="ui-icon"></i></button>
            <button id="preproc-tool-manual" class="preproc-tool-btn" title="Draw explicit manual boxes"><i data-lucide="box-select" class="ui-icon"></i></button>
          </div>
          <div class="preproc-tool-group">
            <button id="preproc-select-all" class="preproc-tool-btn" title="Select full image mask"><i data-lucide="check-check" class="ui-icon"></i></button>
            <button id="preproc-deselect-all" class="preproc-tool-btn" title="Deselect full image mask"><i data-lucide="square" class="ui-icon"></i></button>
            <button id="preproc-clear-manual" class="preproc-tool-btn" title="Clear all manual boxes"><i data-lucide="trash-2" class="ui-icon"></i></button>
          </div>
        </section>

        <section class="preproc-section">
          <div class="preproc-section-head">
            <i data-lucide="sun-moon" class="ui-icon"></i>
            <h4>Preprocessing</h4>
          </div>
          <div class="preproc-field">
            <label>Threshold <span id="preproc-threshold-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-threshold" type="range" min="0" max="255" step="1" title="Convert image to binary at threshold">
              <input id="preproc-threshold-num" type="number" min="0" max="255" step="1" class="control-num">
              <button id="preproc-threshold-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Contrast <span id="preproc-contrast-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-contrast" type="range" min="0.2" max="3" step="0.1" title="Increase/decrease contrast before OCR">
              <input id="preproc-contrast-num" type="number" min="0.2" max="3" step="0.1" class="control-num">
              <button id="preproc-contrast-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Brightness <span id="preproc-brightness-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-brightness" type="range" min="-100" max="100" step="1" title="Increase/decrease brightness before OCR">
              <input id="preproc-brightness-num" type="number" min="-100" max="100" step="1" class="control-num">
              <button id="preproc-brightness-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Dilation <span id="preproc-dilation-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-dilation" type="range" min="-5" max="5" step="1" title="Positive thickens text, negative thins text">
              <input id="preproc-dilation-num" type="number" min="-5" max="5" step="1" class="control-num">
              <button id="preproc-dilation-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-row">
            <label class="preproc-checkbox" title="Invert image colors before OCR">
              <input id="preproc-invert" type="checkbox">
              <span>Invert</span>
            </label>
            <button id="preproc-invert-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
          </div>
        </section>

        <section class="preproc-section" data-rapid-dependent>
          <div class="preproc-section-head">
            <i data-lucide="filter" class="ui-icon"></i>
            <h4>Detection Filter</h4>
            <span class="preproc-live-badge">LIVE</span>
          </div>
          <div class="preproc-field">
            <label>Min Width <span id="preproc-min-width-val" class="val-badge"></span></label>
            <div class="preproc-hint" id="preproc-rule-min-width"></div>
            <div class="preproc-hint" id="preproc-stat-min-width"></div>
            <div class="control-row">
              <input id="preproc-min-width" type="range" min="0" max="0.1" step="0.001" title="Reject boxes narrower than this image-width fraction">
              <input id="preproc-min-width-num" type="number" min="0" max="0.1" step="0.001" class="control-num">
              <button id="preproc-min-width-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Min Height <span id="preproc-min-height-val" class="val-badge"></span></label>
            <div class="preproc-hint" id="preproc-rule-min-height"></div>
            <div class="preproc-hint" id="preproc-stat-min-height"></div>
            <div class="control-row">
              <input id="preproc-min-height" type="range" min="0" max="0.1" step="0.001" title="Reject boxes shorter than this image-height fraction">
              <input id="preproc-min-height-num" type="number" min="0" max="0.1" step="0.001" class="control-num">
              <button id="preproc-min-height-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Median Frac <span id="preproc-median-val" class="val-badge"></span></label>
            <div class="preproc-hint" id="preproc-rule-median"></div>
            <div class="preproc-hint" id="preproc-stat-median"></div>
            <div class="control-row">
              <input id="preproc-median" type="range" min="0.1" max="1.2" step="0.05" title="Adaptive filter against median text height">
              <input id="preproc-median-num" type="number" min="0.1" max="1.2" step="0.05" class="control-num">
              <button id="preproc-median-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>
        </section>

        <section class="preproc-section" data-rapid-dependent>
          <div class="preproc-section-head">
            <i data-lucide="git-merge" class="ui-icon"></i>
            <h4>Merge &amp; Order</h4>
            <span class="preproc-live-badge">LIVE</span>
          </div>
          <div class="preproc-field">
            <label>Reading Direction</label>
            <div class="control-row">
              <select id="preproc-direction" title="Sort reading order for boxes">
                <option value="horizontal_ltr">Horizontal LTR</option>
                <option value="horizontal_rtl">Horizontal RTL</option>
                <option value="vertical_ltr">Vertical LTR</option>
                <option value="vertical_rtl">Vertical RTL</option>
              </select>
              <button id="preproc-direction-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Merge V <span id="preproc-merge-v-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-merge-v" type="range" min="0" max="1" step="0.01" title="Vertical gap merge tolerance">
              <input id="preproc-merge-v-num" type="number" min="0" max="1" step="0.01" class="control-num">
              <button id="preproc-merge-v-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Merge H <span id="preproc-merge-h-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-merge-h" type="range" min="0" max="2" step="0.01" title="Horizontal gap merge tolerance">
              <input id="preproc-merge-h-num" type="number" min="0" max="2" step="0.01" class="control-num">
              <button id="preproc-merge-h-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Width Thresh <span id="preproc-merge-w-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-merge-w" type="range" min="0" max="1" step="0.01" title="Minimum width similarity for vertical merge">
              <input id="preproc-merge-w-num" type="number" min="0" max="1" step="0.01" class="control-num">
              <button id="preproc-merge-w-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>

          <div class="preproc-field">
            <label>Group Tol <span id="preproc-group-val" class="val-badge"></span></label>
            <div class="control-row">
              <input id="preproc-group" type="range" min="0.1" max="1.2" step="0.01" title="Line/column grouping tolerance">
              <input id="preproc-group-num" type="number" min="0.1" max="1.2" step="0.01" class="control-num">
              <button id="preproc-group-reset" class="control-reset" title="Reset"><i data-lucide="rotate-ccw" class="ui-icon"></i></button>
            </div>
          </div>
        </section>

        <section class="preproc-section">
          <div class="preproc-section-head">
            <i data-lucide="bar-chart-3" class="ui-icon"></i>
            <h4>Metrics</h4>
          </div>
          <div id="preproc-metrics" class="preproc-hint">No detection run yet.</div>
          <pre id="preproc-debug-state" class="preproc-debug">No debug state yet</pre>
        </section>
      </aside>

      <main class="preproc-canvas-wrap">
        <div class="preproc-viewer" id="preproc-viewer">
          <img id="preproc-preview" alt="Preprocessed preview" />
          <canvas id="preproc-selection-mask" class="preproc-selection-mask"></canvas>
          <svg id="preproc-overlay-svg" class="preproc-overlay-svg"></svg>
          <div id="preproc-overlay" class="preproc-overlay"></div>
          <div id="preproc-manual-layer" class="preproc-manual-layer"></div>
          <div id="preproc-draw-preview" class="preproc-draw-preview"></div>
        </div>
      </main>
    </div>
  </div>
</div>
`;
