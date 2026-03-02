export const APP_TEMPLATE = `
<div id="desktop">
  <div id="app-shell">
    <div class="window-header" id="window-header">
      <div class="window-title">TTS Snipper</div>
      <div class="window-actions">
        <button id="btn-pin" class="window-btn" title="Toggle always-on-top">📌</button>
        <button id="btn-minimize" class="window-btn" title="Minimize">—</button>
        <button id="btn-maximize" class="window-btn" title="Maximize">□</button>
        <button id="btn-close" class="window-btn close" title="Close">✕</button>
      </div>
    </div>
    <div class="bg-layer"></div>
    <div class="sidebar">
      <div class="sidebar-icon-area">⚙</div>
      <div class="settings-content">
        <div class="setting-group"><label>OCR Base URL</label><input type="text" id="llm-url"></div>
        <div class="setting-group"><label>OCR API Key</label><input type="password" id="llm-key"></div>
        <div class="setting-group">
          <label>OCR Model</label>
          <div class="setting-inline">
            <select id="llm-model"></select>
            <button id="llm-refetch" class="refetch-btn" type="button" title="Refetch OCR models">↻</button>
          </div>
        </div>
        <div class="setting-group"><label>OCR Prompt</label><input type="text" id="llm-prompt"></div>
        <div class="setting-group"><label>TTS Base URL</label><input type="text" id="tts-url"></div>
        <div class="setting-group"><label>TTS API Key</label><input type="password" id="tts-key"></div>
        <div class="setting-group">
          <label>TTS Model</label>
          <div class="setting-inline">
            <select id="tts-model"></select>
            <button id="tts-refetch" class="refetch-btn" type="button" title="Refetch TTS model/voice list">↻</button>
          </div>
        </div>
        <div class="setting-group">
          <label>TTS Voice</label>
          <div class="setting-inline">
            <select id="tts-voice"></select>
            <button id="tts-voice-refetch" class="refetch-btn" type="button" title="Refetch TTS voices">↻</button>
          </div>
        </div>
        <div class="setting-group"><label>Chunk Size</label><input type="number" id="chunk-size" min="1"></div>
        <div class="setting-group"><label>WPM</label><input type="number" id="wpm" min="1"></div>
      </div>
      <div class="sidebar-toggle">›</div>
    </div>

    <div class="main-content">
      <div class="top-actions">
        <button id="btn-capture">Capture</button>
        <label class="upload-btn">Upload<input id="image-upload" type="file" accept="image/*"></label>
        <button id="btn-aot-toggle">Always On Top: On</button>
        <span id="status-text"></span>
      </div>
      <div class="cards-container">
        <div class="card image-card"><img id="preview-img" class="snippet" alt="Capture"></div>
        <div class="card text-card">
          <textarea id="raw-text" placeholder="Text will appear here..."></textarea>
          <div class="divider"></div>
          <div class="reading-preview" id="reading-preview"></div>
        </div>
      </div>
      <div class="controls-bar">
        <div class="btn-group">
          <button id="btn-prev">◀</button>
          <button class="play-btn" id="btn-play">▶</button>
          <button id="btn-next">▶</button>
        </div>
        <div class="slider-group">
          <div class="slider-wrap"><span>🔊</span><input type="range" id="vol-slider" min="0" max="100" value="80"></div>
          <div class="slider-wrap"><span>⏱</span><input type="range" id="speed-slider" min="0.5" max="2" step="0.1" value="1"></div>
        </div>
      </div>
    </div>
  </div>
</div>`;
