(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const brushCursor = $('brushCursor');

  // 取り込む画像の長辺の上限（重すぎる画像は縮小して扱う。タブを複数開くのでメモリ節約）
  const MAX_SRC = 2160;
  const SETTINGS_KEY = 'imgArrangerSettings';
  const SAVED_FIELDS = ['preset', 'bg', 'textTop', 'textBottom', 'textPlace', 'sideWriting', 'font', 'size', 'color', 'weight', 'align', 'brush', 'strength', 'blurType', 'format'];

  const PRESETS = [
    { id: 'ig-portrait', label: 'Instagram 縦 4:5', W: 1080, H: 1350 },
    { id: 'ig-square', label: 'Instagram 正方形 1:1', W: 1080, H: 1080 },
    { id: 'ig-story', label: 'Instagram ストーリーズ 9:16', W: 1080, H: 1920 },
    { id: 'ig-landscape', label: 'Instagram 横 1.91:1', W: 1080, H: 566 },
    { id: 'x-landscape', label: 'X / Twitter 横 16:9', W: 1600, H: 900 },
    { id: 'x-portrait', label: 'X / Twitter 縦 4:5', W: 1080, H: 1350 },
    { id: 'x-square', label: 'X / Twitter 正方形 1:1', W: 1200, H: 1200 },
  ];
  const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

  // 縦書きで90度回転させる文字（長音・括弧・ダッシュなど）
  const ROTATE_CHARS = new Set('ー―‐－〜～…‥（）「」『』【】〔〕［］｛｝〈〉《》＜＞＝→←↑↓：；'.split(''));
  // 縦書きで右上に寄せる文字（句読点）
  const PUNCT_CHARS = new Set('、。，．'.split(''));
  // 縦書きで少し右上に寄せる小書き文字
  const SMALL_KANA = new Set('ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ'.split(''));
  // 行頭・列頭に来てはいけない文字（禁則）
  const NO_LINE_START = new Set('、。，．）」』】〕］｝〉》！？!?)]}ー…'.split(''));
  // 行末に来てはいけない文字（開き括弧）
  const NO_LINE_END = new Set('（「『【〔［｛〈《('.split(''));

  const docs = [];      // タブごとの画像ドキュメント
  let active = null;    // 表示中のドキュメント
  let docSeq = 0;
  let pasteSeq = 0;

  const ui = { mode: 'move' };

  // ---------- 設定の保存（Cookie、使えない環境では localStorage） ----------
  function saveSettings() {
    const data = {};
    SAVED_FIELDS.forEach((k) => { data[k] = $(k).value; });
    data.exportSizes = checkedSizes();
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
        const el = $(k);
        if (data[k] == null) return;
        // 選択肢に無い値（旧バージョンの保存値など）は無視
        if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === data[k])) return;
        el.value = data[k];
      });
      if (Array.isArray(data.exportSizes)) {
        document.querySelectorAll('#exportSizes input').forEach((cb) => {
          cb.checked = data.exportSizes.includes(cb.value);
        });
      }
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
    toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function currentPreset() {
    return presetById($('preset').value);
  }

  function checkedSizes() {
    return [...document.querySelectorAll('#exportSizes input:checked')].map((cb) => cb.value);
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

  // ---------- 画像の読み込み・タブ ----------
  function loadImageFromBlob(blob, name) {
    return new Promise((resolve) => {
      if (!blob || !blob.type.startsWith('image/')) {
        toast('画像ファイルではありません');
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(addDoc(img, name));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        toast('画像を読み込めませんでした（HEICなどはJPEG/PNGに変換してください）');
        resolve(null);
      };
      img.src = url;
    });
  }

  async function loadFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    let last = null;
    for (const f of list) {
      last = (await loadImageFromBlob(f, f.name.replace(/\.[^.]+$/, ''))) || last;
    }
    if (last) activate(last);
  }

  function addDoc(img, name) {
    const r = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * r);
    const h = Math.round(img.naturalHeight * r);
    const src = makeCanvas(w, h);
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, w, h);

    const tr = 64 / Math.max(w, h);
    const th = makeCanvas(Math.max(1, Math.round(w * tr)), Math.max(1, Math.round(h * tr)));
    th.getContext('2d').drawImage(src, 0, 0, th.width, th.height);

    const doc = {
      id: ++docSeq,
      name: name || `画像${docSeq}`,
      src,
      mask: makeCanvas(w, h),
      blurred: null,
      blurKey: '',
      layer: null,
      layerDirty: true,
      strokes: [],
      layouts: {}, // presetId -> {scale, offX, offY}
      thumb: th.toDataURL('image/jpeg', 0.7),
    };
    docs.push(doc);
    renderTabs();
    return doc;
  }

  function activate(doc) {
    // 非表示タブのぼかしキャッシュは捨ててメモリを節約（マスクと筆跡は残す）
    if (active && active !== doc) {
      active.blurred = null;
      active.layer = null;
      active.blurKey = '';
    }
    active = doc;
    stage.classList.toggle('empty', !doc);
    ['downloadBtn', 'downloadAllBtn', 'copyBtn', 'shareBtn'].forEach((id) => { $(id).disabled = !doc; });
    $('downloadAllBtn').textContent = `⬇ 全タブを書き出し${docs.length > 1 ? `（${docs.length}枚）` : ''}`;
    syncLayoutUI();
    renderTabs();
    render();
  }

  function closeDoc(doc) {
    const i = docs.indexOf(doc);
    if (i < 0) return;
    docs.splice(i, 1);
    if (active === doc) {
      active = null;
      activate(docs[Math.min(i, docs.length - 1)] || null);
    } else {
      activate(active);
    }
  }

  function renderTabs() {
    const bar = $('tabs');
    bar.querySelectorAll('.tab').forEach((t) => t.remove());
    const add = bar.querySelector('.tab-add');
    docs.forEach((doc) => {
      const t = document.createElement('div');
      t.className = `tab${doc === active ? ' active' : ''}`;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', doc === active);
      t.title = doc.name;
      const img = document.createElement('img');
      img.src = doc.thumb;
      img.alt = '';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = doc.name;
      const x = document.createElement('button');
      x.className = 'close';
      x.textContent = '×';
      x.title = 'このタブを閉じる';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDoc(doc);
      });
      t.append(img, nm, x);
      t.addEventListener('click', () => activate(doc));
      bar.insertBefore(t, add);
    });
    const at = bar.querySelector('.tab.active');
    if (at) at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function getLayout(doc, presetId) {
    if (!doc.layouts[presetId]) doc.layouts[presetId] = { scale: 1, offX: 0, offY: 0 };
    return doc.layouts[presetId];
  }

  function syncLayoutUI() {
    const pct = active ? Math.round(getLayout(active, currentPreset().id).scale * 100) : 100;
    $('scale').value = pct;
    $('scaleOut').textContent = `${pct}%`;
  }

  // ---------- ぼかし ----------
  function blurKeyNow() {
    return `${$('strength').value}|${$('blurType').value}`;
  }

  function buildBlurred(src) {
    const { width: w, height: h } = src;
    const out = makeCanvas(w, h);
    const o = out.getContext('2d');
    const r = Math.max(1, Number($('strength').value) * Math.max(w, h) / 1000);

    if ($('blurType').value === 'mosaic') {
      const block = Math.max(2, r * 1.5);
      const sw = Math.max(1, Math.round(w / block));
      const sh = Math.max(1, Math.round(h / block));
      const small = makeCanvas(sw, sh);
      small.getContext('2d').drawImage(src, 0, 0, sw, sh);
      o.imageSmoothingEnabled = false;
      o.drawImage(small, 0, 0, w, h);
    } else if (supportsFilter) {
      // 端が透けないよう、元画像を下に敷いてからぼかしを重ねる
      o.drawImage(src, 0, 0);
      o.filter = `blur(${r}px)`;
      o.drawImage(src, 0, 0);
      o.filter = 'none';
    } else {
      // フォールバック: 縮小→拡大でぼかす
      const sw = Math.max(1, Math.round(w / r));
      const sh = Math.max(1, Math.round(h / r));
      const small = makeCanvas(sw, sh);
      const sc = small.getContext('2d');
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(src, 0, 0, sw, sh);
      o.imageSmoothingQuality = 'high';
      o.drawImage(small, 0, 0, w, h);
    }
    return out;
  }

  // ぼかしレイヤー（blurred ∩ mask）を必要なら作り直して返す
  function blurLayer(doc) {
    if (!doc.strokes.length) return null;
    const key = blurKeyNow();
    if (!doc.blurred || doc.blurKey !== key) {
      doc.blurred = buildBlurred(doc.src);
      doc.blurKey = key;
      doc.layerDirty = true;
    }
    if (!doc.layer) {
      doc.layer = makeCanvas(doc.src.width, doc.src.height);
      doc.layerDirty = true;
    }
    if (doc.layerDirty) {
      const l = doc.layer.getContext('2d');
      l.globalCompositeOperation = 'source-over';
      l.clearRect(0, 0, doc.layer.width, doc.layer.height);
      l.drawImage(doc.blurred, 0, 0);
      l.globalCompositeOperation = 'destination-in';
      l.drawImage(doc.mask, 0, 0);
      l.globalCompositeOperation = 'source-over';
      doc.layerDirty = false;
    }
    return doc.layer;
  }

  function strokeSegment(mctx, stroke, from, to) {
    mctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    mctx.strokeStyle = '#000';
    mctx.fillStyle = '#000';
    mctx.lineWidth = stroke.size;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.beginPath();
    if (!from) {
      mctx.arc(to[0], to[1], stroke.size / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.moveTo(from[0], from[1]);
      mctx.lineTo(to[0], to[1]);
      mctx.stroke();
    }
    mctx.globalCompositeOperation = 'source-over';
  }

  function rebuildMask(doc) {
    const m = doc.mask.getContext('2d');
    m.clearRect(0, 0, doc.mask.width, doc.mask.height);
    doc.strokes.forEach((s) => {
      s.points.forEach((p, i) => strokeSegment(m, s, i ? s.points[i - 1] : null, p));
    });
    doc.layerDirty = true;
  }

  // ---------- 描画 ----------
  function computePlacement(doc, preset) {
    const { W, H } = preset;
    const lay = getLayout(doc, preset.id);
    const { width: iw, height: ih } = doc.src;
    const s = Math.min(W / iw, H / ih) * lay.scale;
    const w = iw * s;
    const h = ih * s;
    return { x: (W - w) / 2 + lay.offX, y: (H - h) / 2 + lay.offY, w, h, s };
  }

  function textStyle() {
    return {
      size: Number($('size').value),
      font: `${$('weight').value} ${$('size').value}px "${$('font').value}", "Noto Sans JP", sans-serif`,
      color: $('color').value,
      align: $('align').value,
    };
  }

  // 半角英数の単語は途中で切らず、閉じ括弧・句読点は行頭に来ないように折り返す
  function wrapLines(c, text, maxW) {
    const lines = [];
    text.split('\n').forEach((para) => {
      let line = '';
      const toks = para.match(/[!-~]+|[\s\S]/gu) || [];
      for (const tk of toks) {
        const fits = c.measureText(line + tk).width <= maxW;
        if (fits || !line.trim() || NO_LINE_START.has(tk)) {
          line += tk;
        } else {
          let carry = '';
          while (line.length > 1 && NO_LINE_END.has(line.slice(-1))) {
            carry = line.slice(-1) + carry;
            line = line.slice(0, -1);
          }
          lines.push(line.trimEnd());
          line = carry + tk.trimStart();
        }
        // 1単語だけで幅を超える場合は文字単位で切る
        while (c.measureText(line).width > maxW && line.length > 1 && !NO_LINE_START.has(line)) {
          let i = line.length - 1;
          while (i > 1 && c.measureText(line.slice(0, i)).width > maxW) i--;
          lines.push(line.slice(0, i));
          line = line.slice(i);
        }
      }
      lines.push(line);
    });
    return lines;
  }

  // 領域 r = {x0, y0, x1, y1} の中に横書きで配置
  function drawHorizontal(c, text, r, W, H, st) {
    const pad = Math.round(Math.min(W, H) * 0.04);
    c.font = st.font;
    c.fillStyle = st.color;
    c.textBaseline = 'middle';
    c.textAlign = st.align;
    const lines = wrapLines(c, text, Math.max(st.size, r.x1 - r.x0 - pad * 2));
    const lineH = st.size * 1.35;
    const blockH = lines.length * lineH;
    let y0 = r.y0 + (r.y1 - r.y0 - blockH) / 2;
    y0 = Math.min(Math.max(y0, pad / 2), H - pad / 2 - blockH);
    const x = st.align === 'left' ? r.x0 + pad : st.align === 'right' ? r.x1 - pad : (r.x0 + r.x1) / 2;
    lines.forEach((ln, i) => c.fillText(ln, x, y0 + lineH * (i + 0.5)));
  }

  // 縦書き用に文字列をトークンに分ける（半角英数の連続は横倒しでまとめる）
  function verticalTokens(c, para, size) {
    const toks = [];
    const re = /[!-~](?:[ -~]*[!-~])?|[\s\S]/gu;
    let m;
    while ((m = re.exec(para))) {
      const t = m[0];
      if (t.length > 1 || /[!-~]/.test(t)) {
        toks.push({ t, kind: 'rot', adv: c.measureText(t).width + size * 0.1 });
      } else if (t === ' ' || t === '　') {
        toks.push({ t, kind: 'space', adv: t === ' ' ? size * 0.4 : size });
      } else if (ROTATE_CHARS.has(t)) {
        toks.push({ t, kind: 'rot', adv: Math.max(size, c.measureText(t).width) });
      } else if (PUNCT_CHARS.has(t)) {
        toks.push({ t, kind: 'punct', adv: size });
      } else if (SMALL_KANA.has(t)) {
        toks.push({ t, kind: 'small', adv: size });
      } else {
        toks.push({ t, kind: 'up', adv: size });
      }
    }
    return toks;
  }

  // 領域 r の中に縦書きで配置（列は右から左へ）
  function drawVertical(c, text, r, W, H, st) {
    const pad = Math.round(Math.min(W, H) * 0.04);
    const size = st.size;
    c.font = st.font;
    c.fillStyle = st.color;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    const maxH = Math.max(size, r.y1 - r.y0 - pad * 2);

    const cols = [];
    text.split('\n').forEach((para) => {
      let col = [];
      let hgt = 0;
      verticalTokens(c, para, size).forEach((tk) => {
        if (col.length && hgt + tk.adv > maxH && !NO_LINE_START.has(tk.t)) {
          cols.push({ toks: col, h: hgt });
          col = [];
          hgt = 0;
        }
        col.push(tk);
        hgt += tk.adv;
      });
      cols.push({ toks: col, h: hgt });
    });

    const colW = size * 1.35;
    const blockW = cols.length * colW;
    const blockH = Math.max(...cols.map((cl) => cl.h));
    let right = (r.x0 + r.x1) / 2 + blockW / 2;
    right = Math.min(Math.max(right, blockW + pad / 2), W - pad / 2);
    let top;
    if (st.align === 'left') top = r.y0 + pad;
    else if (st.align === 'right') top = r.y1 - pad - blockH;
    else top = r.y0 + (r.y1 - r.y0 - blockH) / 2;

    cols.forEach((cl, i) => {
      const cx = right - colW * (i + 0.5);
      let y = top;
      cl.toks.forEach((tk) => {
        const cy = y + tk.adv / 2;
        if (tk.kind === 'rot') {
          c.save();
          c.translate(cx, cy);
          c.rotate(Math.PI / 2);
          c.fillText(tk.t, 0, 0);
          c.restore();
        } else if (tk.kind === 'punct') {
          c.fillText(tk.t, cx + size * 0.6, cy - size * 0.6);
        } else if (tk.kind === 'small') {
          c.fillText(tk.t, cx + size * 0.1, cy - size * 0.1);
        } else if (tk.kind === 'up') {
          c.fillText(tk.t, cx, cy);
        }
        y += tk.adv;
      });
    });
  }

  // 余白の向きを決める（上下 or 左右）
  function textSides(p, W, H) {
    const place = $('textPlace').value;
    if (place === 'tb' || place === 'lr') return place;
    const slackV = Math.max(0, p.y) + Math.max(0, H - p.y - p.h);
    const slackH = Math.max(0, p.x) + Math.max(0, W - p.x - p.w);
    return slackH > slackV ? 'lr' : 'tb';
  }

  // 1枚分をキャンバス c に描く（表示・書き出し共通）
  function drawDoc(c, doc, preset) {
    const { W, H } = preset;
    if (c.canvas.width !== W || c.canvas.height !== H) {
      c.canvas.width = W;
      c.canvas.height = H;
    }
    c.fillStyle = $('bg').value;
    c.fillRect(0, 0, W, H);
    if (!doc) return null;

    const p = computePlacement(doc, preset);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(doc.src, p.x, p.y, p.w, p.h);
    const layer = blurLayer(doc);
    if (layer) c.drawImage(layer, p.x, p.y, p.w, p.h);

    const st = textStyle();
    const t1 = $('textTop').value;
    const t2 = $('textBottom').value;
    if (textSides(p, W, H) === 'lr') {
      const draw = $('sideWriting').value === 'vertical' ? drawVertical : drawHorizontal;
      if (t1.trim()) draw(c, t1, { x0: 0, y0: 0, x1: Math.max(0, p.x), y1: H }, W, H, st);
      if (t2.trim()) draw(c, t2, { x0: Math.min(W, p.x + p.w), y0: 0, x1: W, y1: H }, W, H, st);
    } else {
      if (t1.trim()) drawHorizontal(c, t1, { x0: 0, y0: 0, x1: W, y1: Math.max(0, p.y) }, W, H, st);
      if (t2.trim()) drawHorizontal(c, t2, { x0: 0, y0: Math.min(H, p.y + p.h), x1: W, y1: H }, W, H, st);
    }
    return p;
  }

  let rafId = 0;
  let place = null; // 表示中の配置（ポインタ座標変換用）
  function render() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }
  function draw() {
    place = drawDoc(ctx, active, currentPreset());
  }

  // Webフォントは読み込み完了後に描き直す
  function ensureFont() {
    if (!document.fonts) return Promise.resolve();
    const f = textStyle().font;
    const sample = ($('textTop').value + $('textBottom').value) || 'あA';
    if (document.fonts.check(f, sample)) return Promise.resolve();
    return document.fonts.load(f, sample).then(render).catch(() => {});
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
    return [(cxy[0] - place.x) / place.s, (cxy[1] - place.y) / place.s];
  }

  function updateBrushCursor(e) {
    if (ui.mode === 'move' || !active) {
      brushCursor.hidden = true;
      return;
    }
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const d = Number($('brush').value) * r.width / canvas.width;
    brushCursor.hidden = false;
    brushCursor.classList.toggle('erase', ui.mode === 'erase');
    brushCursor.style.width = `${d}px`;
    brushCursor.style.height = `${d}px`;
    brushCursor.style.left = `${e.clientX - sr.left}px`;
    brushCursor.style.top = `${e.clientY - sr.top}px`;
  }

  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!active || !place) return;
    canvas.setPointerCapture(e.pointerId);
    const cxy = toCanvasXY(e);
    if (ui.mode === 'move') {
      drag = { type: 'move', last: cxy, lay: getLayout(active, currentPreset().id) };
      stage.classList.add('dragging');
    } else {
      const stroke = {
        erase: ui.mode === 'erase',
        size: Number($('brush').value) / place.s,
        points: [toImageXY(cxy)],
      };
      active.strokes.push(stroke);
      strokeSegment(active.mask.getContext('2d'), stroke, null, stroke.points[0]);
      active.layerDirty = true;
      drag = { type: 'paint', stroke, doc: active };
      render();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    updateBrushCursor(e);
    if (!drag) return;
    const cxy = toCanvasXY(e);
    if (drag.type === 'move') {
      drag.lay.offX += cxy[0] - drag.last[0];
      drag.lay.offY += cxy[1] - drag.last[1];
      drag.last = cxy;
    } else {
      const pts = drag.stroke.points;
      const pt = toImageXY(cxy);
      strokeSegment(drag.doc.mask.getContext('2d'), drag.stroke, pts[pts.length - 1], pt);
      pts.push(pt);
      drag.doc.layerDirty = true;
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
  PRESETS.forEach((p) => {
    $('preset').add(new Option(`${p.label}（${p.W}×${p.H}）`, p.id));
    const lb = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = p.id === 'ig-portrait';
    cb.addEventListener('change', saveSoon);
    lb.append(cb, `${p.label}（${p.W}×${p.H}）`);
    $('exportSizes').append(lb);
  });

  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.mode = b.dataset.mode;
    $('modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    stage.classList.remove('mode-move', 'mode-blur', 'mode-erase');
    stage.classList.add(`mode-${ui.mode}`);
  });
  stage.classList.add('mode-move');

  function undo() {
    if (!active || !active.strokes.length) return;
    active.strokes.pop();
    rebuildMask(active);
    render();
  }
  $('undoBtn').addEventListener('click', undo);
  $('clearBlurBtn').addEventListener('click', () => {
    if (!active) return;
    active.strokes = [];
    rebuildMask(active);
    render();
  });

  document.querySelectorAll('[data-align]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!active) return;
      const preset = currentPreset();
      const lay = getLayout(active, preset.id);
      const p = computePlacement(active, preset);
      const slackX = (preset.W - p.w) / 2;
      const slackY = (preset.H - p.h) / 2;
      switch (b.dataset.align) {
        case 'top': lay.offY = -slackY; break;
        case 'bottom': lay.offY = slackY; break;
        case 'left': lay.offX = -slackX; break;
        case 'right': lay.offX = slackX; break;
        default: lay.offX = 0; lay.offY = 0;
      }
      render();
    });
  });

  $('scale').addEventListener('input', () => {
    $('scaleOut').textContent = `${$('scale').value}%`;
    if (!active) return;
    getLayout(active, currentPreset().id).scale = Number($('scale').value) / 100;
    render();
  });

  $('preset').addEventListener('change', () => {
    // 編集中のサイズは書き出し対象にも入れておく
    const cb = document.querySelector(`#exportSizes input[value="${$('preset').value}"]`);
    if (cb) cb.checked = true;
    syncLayoutUI();
    saveSoon();
    render();
  });

  ['bg', 'textTop', 'textBottom', 'color', 'size', 'align', 'textPlace', 'sideWriting'].forEach((id) => {
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
      render();
    });
  });
  $('brush').addEventListener('input', saveSoon);
  $('format').addEventListener('change', saveSoon);

  const outputs = { size: 'sizeOut', brush: 'brushOut', strength: 'strengthOut' };
  Object.entries(outputs).forEach(([id, out]) => {
    $(id).addEventListener('input', () => { $(out).textContent = $(id).value; });
  });

  // ---------- 入力（ファイル・ドロップ・貼り付け） ----------
  ['fileInput', 'fileInputTab'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      loadFiles(e.target.files);
      e.target.value = '';
    });
  });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    stage.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, () => stage.classList.remove('dragover')));
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    loadFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return; // 文字の貼り付けはそのまま通す
    e.preventDefault();
    let last = null;
    for (const it of items) {
      last = (await loadImageFromBlob(it.getAsFile(), `貼り付け${++pasteSeq}`)) || last;
    }
    if (last) activate(last);
  });

  $('pasteBtn').addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      let last = null;
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) last = (await loadImageFromBlob(await it.getType(type), `貼り付け${++pasteSeq}`)) || last;
      }
      if (last) activate(last);
      else toast('クリップボードに画像がありません');
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
  function renderBlob(doc, preset, type) {
    const c = makeCanvas(preset.W, preset.H).getContext('2d');
    drawDoc(c, doc, preset);
    return new Promise((res) => c.canvas.toBlob(res, type, 0.95));
  }

  function safeName(s) {
    return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'image';
  }

  function fileName(doc, preset) {
    const ext = $('format').value === 'image/png' ? 'png' : 'jpg';
    return `${safeName(doc.name)}_${preset.id}_${preset.W}x${preset.H}.${ext}`;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function exportDocs(targets) {
    const sizes = checkedSizes().map(presetById);
    if (!sizes.length) {
      toast('書き出すサイズを1つ以上選んでください');
      return;
    }
    await ensureFont();
    const type = $('format').value;
    const jobs = [];
    targets.forEach((doc) => sizes.forEach((preset) => jobs.push({ doc, preset })));

    if (jobs.length > 1) toast(`${jobs.length}枚を書き出し中…`);
    const used = new Set();
    for (const [i, { doc, preset }] of jobs.entries()) {
      let n = fileName(doc, preset);
      // タブ名が同じ画像があってもファイル名が被らないようにする
      for (let k = 2; used.has(n); k++) n = fileName(doc, preset).replace(/(\.\w+)$/, `_${k}$1`);
      used.add(n);
      downloadBlob(await renderBlob(doc, preset, type), n);
      // 連続ダウンロードがブラウザに間引かれないよう少し間を空ける
      if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
    if (jobs.length > 1) toast(`${jobs.length}枚を保存しました`);
  }

  $('downloadBtn').addEventListener('click', () => active && exportDocs([active]));
  $('downloadAllBtn').addEventListener('click', () => docs.length && exportDocs(docs));

  $('copyBtn').addEventListener('click', async () => {
    if (!active) return;
    try {
      // Safari は Promise を渡す形でないと失敗するため、この書き方にする
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderBlob(active, currentPreset(), 'image/png') })]);
      toast('画像をコピーしました');
    } catch (_) {
      toast('コピーに対応していないブラウザです');
    }
  });

  if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })) {
    $('shareBtn').hidden = false;
    $('shareBtn').addEventListener('click', async () => {
      if (!active) return;
      const type = $('format').value;
      const sizes = checkedSizes().map(presetById);
      const list = sizes.length ? sizes : [currentPreset()];
      const files = [];
      for (const preset of list) {
        const blob = await renderBlob(active, preset, type);
        files.push(new File([blob], fileName(active, preset), { type: blob.type }));
      }
      try {
        await navigator.share({ files });
      } catch (_) { /* キャンセル */ }
    });
  }

  // ---------- 初期化 ----------
  loadSettings();
  Object.entries(outputs).forEach(([id, out]) => { $(out).textContent = $(id).value; });
  ensureFont();
  activate(null);
})();
