(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const brushCursor = $('brushCursor');

  // 取り込む画像の長辺の上限（重すぎる画像は縮小して扱う）
  const MAX_SRC = 2400;
  const SETTINGS_KEY = 'imgArrangerSettings';
  const SAVED_FIELDS = ['preset', 'bg', 'textTop', 'textBottom', 'font', 'size', 'color', 'weight', 'align', 'brush', 'strength', 'blurType', 'format'];

  const state = {
    src: null,       // 元画像（縮小済み）canvas
    blurred: null,   // 全体をぼかした canvas
    mask: null,      // ぼかし範囲のマスク canvas
    layer: null,     // blurred ∩ mask
    strokes: [],     // {erase, size, points:[[x,y]...]}（元画像座標）
    scale: 1,
    offX: 0,
    offY: 0,
    mode: 'move',
    place: { x: 0, y: 0, w: 0, h: 0, s: 1 },
  };

  // ---------- 設定の保存（Cookie、使えない環境では localStorage） ----------
  function saveSettings() {
    const data = {};
    SAVED_FIELDS.forEach((k) => { data[k] = $(k).value; });
    const json = JSON.stringify(data);
    document.cookie = `${SETTINGS_KEY}=${encodeURIComponent(json)}; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
    try { localStorage.setItem(SETTINGS_KEY, json); } catch (_) { /* 使えなくても無視 */ }
  }

  function loadSettings() {
    let json = null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${SETTINGS_KEY}=([^;]*)`));
    if (m) json = decodeURIComponent(m[1]);
    if (!json) {
      try { json = localStorage.getItem(SETTINGS_KEY); } catch (_) { /* noop */ }
    }
    if (!json) return;
    try {
      const data = JSON.parse(json);
      SAVED_FIELDS.forEach((k) => {
        if (data[k] != null) $(k).value = data[k];
      });
    } catch (_) { /* 壊れていたら無視 */ }
  }

  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 300);
  }

  // ---------- ユーティリティ ----------
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function outputSize() {
    const [w, h] = $('preset').value.split('x').map((v) => parseInt(v, 10));
    return { W: w, H: h };
  }

  // ctx.filter が実際に効くか（古い Safari はプロパティがあっても無効）
  const supportsFilter = (() => {
    const c = makeCanvas(20, 10);
    const x = c.getContext('2d');
    if (!('filter' in x)) return false;
    x.filter = 'blur(3px)';
    x.fillRect(0, 0, 10, 10);
    return x.getImageData(12, 5, 1, 1).data[3] > 0;
  })();

  // ---------- 画像の読み込み ----------
  function loadImageFromBlob(blob) {
    if (!blob || !blob.type.startsWith('image/')) {
      toast('画像ファイルではありません');
      return;
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      setSource(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('画像を読み込めませんでした（HEICなどはJPEG/PNGに変換してください）');
    };
    img.src = url;
  }

  function setSource(img) {
    const r = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * r);
    const h = Math.round(img.naturalHeight * r);
    const src = makeCanvas(w, h);
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, w, h);

    state.src = src;
    state.mask = makeCanvas(w, h);
    state.layer = makeCanvas(w, h);
    state.strokes = [];
    state.scale = 1;
    state.offX = 0;
    state.offY = 0;
    $('scale').value = 100;
    $('scaleOut').textContent = '100%';

    rebuildBlurred();
    stage.classList.remove('empty');
    ['downloadBtn', 'copyBtn', 'shareBtn'].forEach((id) => { $(id).disabled = false; });
    render();
  }

  // ---------- ぼかし ----------
  function blurRadius() {
    const { width, height } = state.src;
    return Number($('strength').value) * Math.max(width, height) / 1000;
  }

  function rebuildBlurred() {
    if (!state.src) return;
    const { width: w, height: h } = state.src;
    const out = makeCanvas(w, h);
    const o = out.getContext('2d');
    const r = Math.max(1, blurRadius());

    if ($('blurType').value === 'mosaic') {
      const block = Math.max(2, r * 1.5);
      const sw = Math.max(1, Math.round(w / block));
      const sh = Math.max(1, Math.round(h / block));
      const small = makeCanvas(sw, sh);
      small.getContext('2d').drawImage(state.src, 0, 0, sw, sh);
      o.imageSmoothingEnabled = false;
      o.drawImage(small, 0, 0, w, h);
    } else if (supportsFilter) {
      // 端が透けないよう、元画像を下に敷いてからぼかしを重ねる
      o.drawImage(state.src, 0, 0);
      o.filter = `blur(${r}px)`;
      o.drawImage(state.src, 0, 0);
      o.filter = 'none';
    } else {
      // フォールバック: 縮小→拡大でぼかす
      const sw = Math.max(1, Math.round(w / r));
      const sh = Math.max(1, Math.round(h / r));
      const small = makeCanvas(sw, sh);
      const sc = small.getContext('2d');
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(state.src, 0, 0, sw, sh);
      o.imageSmoothingQuality = 'high';
      o.drawImage(small, 0, 0, w, h);
    }
    state.blurred = out;
    updateLayer();
  }

  function strokeSegment(mctx, stroke, from, to) {
    mctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    mctx.strokeStyle = '#000';
    mctx.fillStyle = '#000';
    mctx.lineWidth = stroke.size;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    if (!from) {
      mctx.beginPath();
      mctx.arc(to[0], to[1], stroke.size / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.beginPath();
      mctx.moveTo(from[0], from[1]);
      mctx.lineTo(to[0], to[1]);
      mctx.stroke();
    }
    mctx.globalCompositeOperation = 'source-over';
  }

  function rebuildMask() {
    if (!state.mask) return;
    const m = state.mask.getContext('2d');
    m.clearRect(0, 0, state.mask.width, state.mask.height);
    state.strokes.forEach((s) => {
      s.points.forEach((p, i) => strokeSegment(m, s, i ? s.points[i - 1] : null, p));
    });
    updateLayer();
  }

  function updateLayer() {
    if (!state.layer || !state.blurred) return;
    const l = state.layer.getContext('2d');
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, state.layer.width, state.layer.height);
    l.drawImage(state.blurred, 0, 0);
    l.globalCompositeOperation = 'destination-in';
    l.drawImage(state.mask, 0, 0);
    l.globalCompositeOperation = 'source-over';
  }

  // ---------- 描画 ----------
  function computePlacement(W, H) {
    const { width: iw, height: ih } = state.src;
    const s = Math.min(W / iw, H / ih) * state.scale;
    const w = iw * s;
    const h = ih * s;
    return { x: (W - w) / 2 + state.offX, y: (H - h) / 2 + state.offY, w, h, s };
  }

  function fontString(size) {
    return `${$('weight').value} ${size}px "${$('font').value}", "Noto Sans JP", sans-serif`;
  }

  function wrapLines(text, maxW) {
    const lines = [];
    text.split('\n').forEach((para) => {
      let line = '';
      for (const ch of para) {
        if (line && ctx.measureText(line + ch).width > maxW) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      lines.push(line);
    });
    return lines;
  }

  function drawTextBlock(text, top, bottom, W, H) {
    if (!text.trim()) return;
    const size = Number($('size').value);
    const pad = Math.round(W * 0.05);
    ctx.font = fontString(size);
    ctx.fillStyle = $('color').value;
    ctx.textBaseline = 'middle';
    const align = $('align').value;
    ctx.textAlign = align;

    const lines = wrapLines(text, W - pad * 2);
    const lineH = size * 1.35;
    const blockH = lines.length * lineH;
    let y0 = top + (bottom - top - blockH) / 2;
    y0 = Math.min(Math.max(y0, pad / 2), H - pad / 2 - blockH);
    const x = align === 'left' ? pad : align === 'right' ? W - pad : W / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x, y0 + lineH * (i + 0.5)));
  }

  let rafId = 0;
  function render() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  function draw() {
    const { W, H } = outputSize();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    ctx.fillStyle = $('bg').value;
    ctx.fillRect(0, 0, W, H);
    if (!state.src) return;

    const p = computePlacement(W, H);
    state.place = p;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.src, p.x, p.y, p.w, p.h);
    if (state.strokes.length) ctx.drawImage(state.layer, p.x, p.y, p.w, p.h);

    drawTextBlock($('textTop').value, 0, Math.max(0, p.y), W, H);
    drawTextBlock($('textBottom').value, Math.min(H, p.y + p.h), H, W, H);
  }

  // Webフォントは読み込み完了後に描き直す
  function ensureFont() {
    const f = fontString(Number($('size').value));
    const sample = ($('textTop').value + $('textBottom').value) || 'あA';
    if (document.fonts && !document.fonts.check(f, sample)) {
      document.fonts.load(f, sample).then(render).catch(() => {});
    }
  }

  // ---------- ポインタ操作 ----------
  function toCanvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * canvas.width / r.width,
      (e.clientY - r.top) * canvas.height / r.height,
    ];
  }

  function toImageXY(cxy) {
    const p = state.place;
    return [(cxy[0] - p.x) / p.s, (cxy[1] - p.y) / p.s];
  }

  function updateBrushCursor(e) {
    if (state.mode === 'move' || !state.src) {
      brushCursor.hidden = true;
      return;
    }
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const d = Number($('brush').value) * r.width / canvas.width;
    brushCursor.hidden = false;
    brushCursor.classList.toggle('erase', state.mode === 'erase');
    brushCursor.style.width = `${d}px`;
    brushCursor.style.height = `${d}px`;
    brushCursor.style.left = `${e.clientX - sr.left}px`;
    brushCursor.style.top = `${e.clientY - sr.top}px`;
  }

  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.src) return;
    canvas.setPointerCapture(e.pointerId);
    const cxy = toCanvasXY(e);
    if (state.mode === 'move') {
      drag = { type: 'move', last: cxy };
      stage.classList.add('dragging');
    } else {
      const stroke = {
        erase: state.mode === 'erase',
        size: Number($('brush').value) / state.place.s,
        points: [toImageXY(cxy)],
      };
      state.strokes.push(stroke);
      strokeSegment(state.mask.getContext('2d'), stroke, null, stroke.points[0]);
      updateLayer();
      drag = { type: 'paint', stroke };
      render();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    updateBrushCursor(e);
    if (!drag) return;
    const cxy = toCanvasXY(e);
    if (drag.type === 'move') {
      state.offX += cxy[0] - drag.last[0];
      state.offY += cxy[1] - drag.last[1];
      drag.last = cxy;
    } else {
      const pts = drag.stroke.points;
      const pt = toImageXY(cxy);
      strokeSegment(state.mask.getContext('2d'), drag.stroke, pts[pts.length - 1], pt);
      pts.push(pt);
      updateLayer();
    }
    render();
  });

  const endDrag = () => {
    drag = null;
    stage.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { brushCursor.hidden = true; });

  // ---------- UI ----------
  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.mode = b.dataset.mode;
    $('modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    stage.classList.remove('mode-move', 'mode-blur', 'mode-erase');
    stage.classList.add(`mode-${state.mode}`);
  });
  stage.classList.add('mode-move');

  function undo() {
    if (!state.strokes.length) return;
    state.strokes.pop();
    rebuildMask();
    render();
  }
  $('undoBtn').addEventListener('click', undo);
  $('clearBlurBtn').addEventListener('click', () => {
    state.strokes = [];
    rebuildMask();
    render();
  });

  document.querySelectorAll('[data-align]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.src) return;
      const { W, H } = outputSize();
      const p = computePlacement(W, H);
      const slackY = (H - p.h) / 2;
      state.offX = 0;
      state.offY = { top: -slackY, center: 0, bottom: slackY }[b.dataset.align];
      render();
    });
  });

  $('scale').addEventListener('input', () => {
    state.scale = Number($('scale').value) / 100;
    $('scaleOut').textContent = `${$('scale').value}%`;
    render();
  });

  $('preset').addEventListener('change', () => {
    state.offX = 0;
    state.offY = 0;
    saveSoon();
    render();
  });

  ['bg', 'textTop', 'textBottom', 'color', 'size', 'align'].forEach((id) => {
    $(id).addEventListener('input', () => {
      saveSoon();
      render();
    });
  });
  ['font', 'weight'].forEach((id) => {
    $(id).addEventListener('change', () => {
      saveSoon();
      ensureFont();
      render();
    });
  });
  ['strength', 'blurType'].forEach((id) => {
    $(id).addEventListener('change', () => {
      saveSoon();
      rebuildBlurred();
      render();
    });
  });
  $('brush').addEventListener('input', saveSoon);
  $('format').addEventListener('change', saveSoon);

  const outputs = { size: 'sizeOut', brush: 'brushOut', strength: 'strengthOut' };
  Object.entries(outputs).forEach(([id, out]) => {
    const sync = () => { $(out).textContent = $(id).value; };
    $(id).addEventListener('input', sync);
  });

  // ---------- 入力（ファイル・ドロップ・貼り付け） ----------
  ['fileInput', 'fileInput2'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadImageFromBlob(f);
      e.target.value = '';
    });
  });

  ['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault();
    stage.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, () => stage.classList.remove('dragover')));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) loadImageFromBlob(f);
  });

  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return; // 文字の貼り付けはそのまま通す
    e.preventDefault();
    loadImageFromBlob(item.getAsFile());
  });

  $('pasteBtn').addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          loadImageFromBlob(await it.getType(type));
          return;
        }
      }
      toast('クリップボードに画像がありません');
    } catch (_) {
      toast('読み取れませんでした。⌘V / Ctrl+V で貼り付けてください');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !/TEXTAREA|INPUT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      undo();
    }
  });

  // ---------- 書き出し ----------
  function canvasBlob(type) {
    draw(); // 最新状態を確実に反映
    return new Promise((res) => canvas.toBlob(res, type, 0.95));
  }

  function fileName() {
    const { W, H } = outputSize();
    const ext = $('format').value === 'image/png' ? 'png' : 'jpg';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return `arranged_${W}x${H}_${stamp}.${ext}`;
  }

  $('downloadBtn').addEventListener('click', async () => {
    const blob = await canvasBlob($('format').value);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('copyBtn').addEventListener('click', async () => {
    try {
      // Safari は Promise を渡す形でないと失敗するため、この書き方にする
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob('image/png') })]);
      toast('画像をコピーしました');
    } catch (_) {
      toast('コピーに対応していないブラウザです');
    }
  });

  if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })) {
    $('shareBtn').hidden = false;
    $('shareBtn').addEventListener('click', async () => {
      const blob = await canvasBlob($('format').value);
      const file = new File([blob], fileName(), { type: blob.type });
      try {
        await navigator.share({ files: [file] });
      } catch (_) { /* キャンセル */ }
    });
  }

  // ---------- 初期化 ----------
  loadSettings();
  Object.entries(outputs).forEach(([id, out]) => { $(out).textContent = $(id).value; });
  stage.classList.add('empty');
  ensureFont();
  render();
})();
