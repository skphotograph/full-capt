const MAX_SIDE = 32767;
const MAX_PIXELS = 80_000_000;
const MAX_TILES = 120;
const MAX_LAYOUT_RETRIES = 2;
const LAYOUT_RETRY_DELAY_MS = 350;
// Chrome allows at most two captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 550;

export class CaptureError extends Error {}

class PageSizeChangedError extends CaptureError {}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function offsets(total, viewport) {
  // Chrome clamps the final scroll to the document edge, leaving an overlap.
  const last = total - viewport;
  const starts = [0];
  for (let start = viewport; start < last; start += viewport) starts.push(start);
  if (last > 0) starts.push(last);
  return starts;
}

function checkLayout(initial, current, x, y) {
  if (!current) throw new CaptureError('撮影中にページが開き直されたため、中断しました。');
  const viewport = ['viewWidth', 'viewHeight', 'dpr'];
  if (viewport.some((field) => initial[field] !== current[field])) {
    throw new CaptureError('撮影中にウィンドウの大きさや表示倍率が変わりました。表示を固定してから、もう一度撮影してください。');
  }
  const dimensions = ['width', 'height', 'left'];
  if (dimensions.some((field) => initial[field] !== current[field])) {
    throw new PageSizeChangedError('撮影をやり直しましたが、ページの大きさが変わり続けています。表示が落ち着いてから、もう一度撮影してください。');
  }
  if (Math.abs(current.x - x) > 1 || Math.abs(current.y - y) > 1) {
    throw new CaptureError('ページを撮影位置に固定できませんでした。ページの自動スクロールを止めてからお試しください。');
  }
}

function decodeImage(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

async function captureVisibleTab(windowId) {
  let timeout;
  try {
    return await Promise.race([
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new CaptureError(
          'Chromeから画像を取得できませんでした。撮影するウィンドウを表示した状態でお試しください。',
        )), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function pixelScale(pixels, cssPixels, dpr) {
  return Math.abs(pixels - cssPixels * dpr) <= 1 ? dpr : pixels / cssPixels;
}

function drawTile(context, image, layout, x, y, left, top, scaleX, scaleY) {
  const right = Math.min(layout.width, x + layout.viewWidth);
  const bottom = Math.min(layout.height, y + layout.viewHeight);
  const edgeX = (value) => Math.round(value * scaleX);
  const edgeY = (value) => Math.round(value * scaleY);
  const width = edgeX(right) - edgeX(left);
  const height = edgeY(bottom) - edgeY(top);
  const sourceX = Math.max(0, Math.min(edgeX(left - x), image.width - width));
  const sourceY = Math.max(0, Math.min(edgeY(top - y), image.height - height));
  context.drawImage(image, sourceX, sourceY, Math.min(width, image.width - sourceX),
    Math.min(height, image.height - sourceY), edgeX(left), edgeY(top), width, height);
}

export async function capturePage(tabId, windowId, onProgress) {
  let canceled = false;
  let documentId;
  let lastCapture = -Infinity;

  function onActivated(info) {
    if (info.windowId === windowId && info.tabId !== tabId) canceled = true;
  }
  function onUpdated(id, change) {
    if (id === tabId && change.status === 'loading') canceled = true;
  }
  function onRemoved(id) {
    if (id === tabId) canceled = true;
  }

  async function checkActiveTab() {
    const [active] = await chrome.tabs.query({ windowId, active: true });
    if (canceled || active?.id !== tabId) {
      throw new CaptureError('撮影するタブから離れたため、中断しました。対象タブで再度お試しください。');
    }
  }

  async function page(method, ...args) {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: (name, values) => globalThis.__fullCaptPage?.[name](...values),
      args: [method, args],
    });
    return frame?.result;
  }

  async function captureAttempt(retry) {
    let canvas;
    let context;
    let scaleX;
    let scaleY;

    const layout = await page('inspect');
    if (!layout?.viewWidth || !layout.viewHeight) throw new CaptureError('ページの表示範囲を取得できませんでした。');
    const tileCount = Math.ceil(layout.width / layout.viewWidth) * Math.ceil(layout.height / layout.viewHeight);
    const sizeError = new CaptureError('ページが大きすぎて1枚のPNGにできません。Chromeの表示倍率を下げてからお試しください。');
    if (tileCount > MAX_TILES) throw sizeError;

    const columns = offsets(layout.width, layout.viewWidth);
    const rows = offsets(layout.height, layout.viewHeight);
    let completed = 0;
    let top = 0;
    onProgress(completed, tileCount, retry);

    for (const y of rows) {
      let left = 0;
      for (const x of columns) {
        await checkActiveTab();
        const location = await page('move', x, y, completed === 0);
        checkLayout(layout, location, x, y);
        const wait = CAPTURE_INTERVAL_MS - (performance.now() - lastCapture);
        if (wait > 0) await delay(wait);

        checkLayout(layout, await page('inspect'), location.x, location.y);
        await checkActiveTab();
        lastCapture = performance.now();
        const dataUrl = await captureVisibleTab(windowId);
        // The API captures the active tab, so discard the frame after any tab switch.
        await checkActiveTab();
        checkLayout(layout, await page('inspect'), location.x, location.y);
        const image = await decodeImage(dataUrl);

        try {
          if (!canvas) {
            scaleX = pixelScale(image.width, layout.viewWidth, layout.dpr);
            scaleY = pixelScale(image.height, layout.viewHeight, layout.dpr);
            const width = Math.round(layout.width * scaleX);
            const height = Math.round(layout.height * scaleY);
            if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw sizeError;
            canvas = new OffscreenCanvas(width, height);
            context = canvas.getContext('2d', { alpha: false });
            if (!context) throw sizeError;
          }

          drawTile(context, image, layout, x, y, left, top, scaleX, scaleY);
        } finally {
          image.close();
        }
        left = Math.min(layout.width, x + layout.viewWidth);
        onProgress(++completed, tileCount, retry);
      }
      top = Math.min(layout.height, y + layout.viewHeight);
    }

    return canvas;
  }

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onDetached.addListener(onRemoved);

  let canvas;
  try {
    for (let retry = 0; ; retry++) {
      await checkActiveTab();
      try {
        const target = documentId ? { tabId, documentIds: [documentId] } : { tabId };
        const [frame] = await chrome.scripting.executeScript({ target, files: ['page.js'] });
        documentId = frame.documentId;
      } catch {
        if (canceled) await checkActiveTab();
        throw new CaptureError('このページでは全体撮影を実行できません。通常のWebページでお試しください。');
      }

      try {
        canvas = await captureAttempt(retry);
        break;
      } catch (error) {
        if (!(error instanceof PageSizeChangedError) || retry >= MAX_LAYOUT_RETRIES) throw error;
        await delay(LAYOUT_RETRY_DELAY_MS);
      } finally {
        await page('restore').catch(() => {});
      }
    }
  } finally {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onDetached.removeListener(onRemoved);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, width: canvas.width, height: canvas.height };
}
