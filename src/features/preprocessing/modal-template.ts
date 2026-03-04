export const PREPROCESS_MODAL_TEMPLATE = `
<div class="preproc-modal-backdrop" data-preproc-modal hidden style="display:none;pointer-events:none;">
  <div class="preproc-modal">
    <div class="preproc-modal-header">
      <h3>Image Preprocessing Lab</h3>
      <button id="preproc-close" class="window-btn">Close</button>
    </div>
    <div class="preproc-modal-body">
      <aside class="preproc-sidebar">
        <section>
          <h4>RapidOCR</h4>
          <label><input id="preproc-rapid-enabled" type="checkbox"> Enable RapidOCR</label>
          <label>Server URL</label>
          <div class="row-inline">
            <input id="preproc-rapid-url" type="text" placeholder="http://127.0.0.1:8091" />
            <button id="preproc-rapid-health" class="window-btn">Health</button>
          </div>
          <div id="preproc-health-status" class="hint">Idle</div>
        </section>

        <section>
          <h4>Quality</h4>
          <label>Max Image Dimension <span id="preproc-max-dim-val"></span></label>
          <input id="preproc-max-dim" type="range" min="360" max="3840" step="60">
        </section>

        <section>
          <h4>Preprocessing</h4>
          <label>Binary Threshold <span id="preproc-threshold-val"></span></label>
          <input id="preproc-threshold" type="range" min="0" max="255" step="1">
          <label>Contrast <span id="preproc-contrast-val"></span></label>
          <input id="preproc-contrast" type="range" min="0.2" max="3" step="0.1">
          <label>Brightness <span id="preproc-brightness-val"></span></label>
          <input id="preproc-brightness" type="range" min="-100" max="100" step="1">
          <label>Dilation/Erosion <span id="preproc-dilation-val"></span></label>
          <input id="preproc-dilation" type="range" min="-5" max="5" step="1">
          <label><input id="preproc-invert" type="checkbox"> Invert</label>
        </section>

        <section>
          <h4>Detection Filter</h4>
          <label>Min Width Ratio <span id="preproc-min-width-val"></span></label>
          <input id="preproc-min-width" type="range" min="0" max="0.1" step="0.001">
          <label>Min Height Ratio <span id="preproc-min-height-val"></span></label>
          <input id="preproc-min-height" type="range" min="0" max="0.1" step="0.001">
          <label>Median Height Fraction <span id="preproc-median-val"></span></label>
          <input id="preproc-median" type="range" min="0.1" max="1.2" step="0.05">
        </section>

        <section>
          <h4>Merging + Order</h4>
          <label>Reading Direction</label>
          <select id="preproc-direction">
            <option value="horizontal_ltr">Horizontal LTR</option>
            <option value="horizontal_rtl">Horizontal RTL</option>
            <option value="vertical_ltr">Vertical LTR</option>
            <option value="vertical_rtl">Vertical RTL</option>
          </select>
          <label>Merge Vertical Ratio <span id="preproc-merge-v-val"></span></label>
          <input id="preproc-merge-v" type="range" min="0" max="1" step="0.01">
          <label>Merge Horizontal Ratio <span id="preproc-merge-h-val"></span></label>
          <input id="preproc-merge-h" type="range" min="0" max="2" step="0.01">
          <label>Merge Width Ratio Threshold <span id="preproc-merge-w-val"></span></label>
          <input id="preproc-merge-w" type="range" min="0" max="1" step="0.01">
          <label>Group Tolerance <span id="preproc-group-val"></span></label>
          <input id="preproc-group" type="range" min="0.1" max="1.2" step="0.01">
        </section>

        <section>
          <h4>Selection Tools</h4>
          <div class="row-inline">
            <button id="preproc-tool-none" class="window-btn">View</button>
            <button id="preproc-tool-add" class="window-btn">Add</button>
            <button id="preproc-tool-sub" class="window-btn">Remove</button>
            <button id="preproc-tool-manual" class="window-btn">Manual</button>
          </div>
          <div class="row-inline">
            <button id="preproc-select-all" class="window-btn">Select All</button>
            <button id="preproc-deselect-all" class="window-btn">Deselect All</button>
            <button id="preproc-clear-manual" class="window-btn">Clear Manual</button>
          </div>
          <div id="preproc-metrics" class="hint">No detection run yet.</div>
        </section>
      </aside>

      <main class="preproc-canvas-wrap">
        <div class="preproc-viewer" id="preproc-viewer">
          <img id="preproc-preview" alt="Preprocessed preview" />
          <div id="preproc-overlay" class="preproc-overlay"></div>
          <div id="preproc-draw-preview" class="preproc-draw-preview"></div>
        </div>
      </main>
    </div>
  </div>
</div>
`;
