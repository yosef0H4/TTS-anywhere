export const APP_TEMPLATE = `
<div id="desktop">
  <div id="app-shell">
    <div class="window-header" id="window-header">
      <div class="window-title">TTS Snipper</div>
      <div class="window-actions">
        <button id="btn-pin" class="window-btn" title="Toggle always-on-top"><i data-lucide="pin" class="ui-icon"></i></button>
        <button id="btn-minimize" class="window-btn" title="Minimize"><i data-lucide="minus" class="ui-icon"></i></button>
        <button id="btn-maximize" class="window-btn" title="Maximize"><i data-lucide="square" class="ui-icon"></i></button>
        <button id="btn-close" class="window-btn close" title="Close"><i data-lucide="x" class="ui-icon"></i></button>
      </div>
    </div>
    <div class="bg-layer"></div>
    <div class="sidebar">
      <div class="sidebar-icon-area"><i data-lucide="settings-2" class="ui-icon"></i></div>
      <div class="settings-content">
        <div class="setting-group">
          <label>Theme</label>
          <select id="ui-theme">
            <option value="zen">Zen</option>
            <option value="pink">Pink</option>
          </select>
        </div>
        <div class="setting-group"><label>OCR Base URL</label><input type="text" id="llm-url"></div>
        <div class="setting-group"><label>OCR API Key</label><input type="password" id="llm-key"></div>
        <div class="setting-group">
          <label>OCR Model</label>
          <div class="setting-inline">
            <select id="llm-model"></select>
            <button id="llm-refetch" class="refetch-btn" type="button" title="Refetch OCR models"><i data-lucide="refresh-cw" class="ui-icon"></i></button>
          </div>
        </div>
        <div class="setting-group"><label>OCR Prompt</label><input type="text" id="llm-prompt"></div>
        <div class="setting-group"><label>TTS Base URL</label><input type="text" id="tts-url"></div>
        <div class="setting-group"><label>TTS API Key</label><input type="password" id="tts-key"></div>
        <div class="setting-group">
          <label>TTS Model</label>
          <div class="setting-inline">
            <select id="tts-model"></select>
            <button id="tts-refetch" class="refetch-btn" type="button" title="Refetch TTS model/voice list"><i data-lucide="refresh-cw" class="ui-icon"></i></button>
          </div>
        </div>
        <div class="setting-group">
          <label>TTS Voice</label>
          <div class="setting-inline">
            <select id="tts-voice"></select>
            <button id="tts-voice-refetch" class="refetch-btn" type="button" title="Refetch TTS voices"><i data-lucide="refresh-cw" class="ui-icon"></i></button>
          </div>
        </div>
        <div class="setting-group"><label>Min Words / Chunk</label><input type="number" id="chunk-min" min="1"></div>
        <div class="setting-group"><label>Max Words / Chunk</label><input type="number" id="chunk-max" min="1"></div>
        <div class="setting-group"><label>WPM</label><input type="number" id="wpm" min="1"></div>
      </div>
      <div class="sidebar-toggle">›</div>
    </div>

    <div class="main-content">
      <div class="top-actions">
        <button id="btn-capture" class="icon-pill" title="Capture"><i data-lucide="camera" class="ui-icon"></i></button>
        <label class="upload-btn icon-pill" title="Upload image"><i data-lucide="upload" class="ui-icon"></i><input id="image-upload" type="file" accept="image/*"></label>
        <span id="status-text"></span>
      </div>
      <div class="cards-container">
        <div class="card image-card">
          <div id="image-empty" class="image-empty">
            <i data-lucide="image-plus" class="ui-icon"></i>
            <span>No capture yet</span>
          </div>
          <img id="preview-img" class="snippet hidden" alt="Capture">
        </div>
        <div class="card text-card">
          <textarea id="raw-text" placeholder="Text will appear here..."></textarea>
          <div class="divider"></div>
          <div class="reading-preview" id="reading-preview"></div>
        </div>
      </div>
      <div class="controls-bar">
        <div class="btn-group">
          <button id="btn-prev" title="Previous chunk"><i data-lucide="skip-back" class="ui-icon"></i></button>
          <button class="play-btn" id="btn-play" title="Play"><i data-lucide="play" class="ui-icon"></i></button>
          <button id="btn-next" title="Next chunk"><i data-lucide="skip-forward" class="ui-icon"></i></button>
        </div>
        <div class="slider-group">
          <div class="slider-wrap"><i data-lucide="volume-2" class="ui-icon"></i><input type="range" id="vol-slider" min="0" max="100" value="80"><input type="number" id="vol-input" class="slider-number-input" min="0" max="100"></div>
          <div class="slider-wrap"><i data-lucide="timer" class="ui-icon"></i><input type="range" id="speed-slider" min="0.5" max="2" step="0.1" value="1"><input type="number" id="speed-input" class="slider-number-input" min="0.5" max="2" step="0.1"></div>
        </div>
      </div>
    </div>
  </div>
</div>`;
