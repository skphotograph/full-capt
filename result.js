import { CaptureError, capturePage } from './capture.js';

const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
const actions = document.querySelector('#actions');
const copy = document.querySelector('#copy');
const save = document.querySelector('#save');
const params = new URLSearchParams(location.hash.slice(1));
const tabId = Number(params.get('tab'));
const windowId = Number(params.get('window'));
history.replaceState(null, '', location.pathname);

async function start() {
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(windowId) || windowId <= 0) {
    status.textContent = '撮影するページで、ツールバーの Full Capt を押してください。';
    return;
  }

  const resultTab = await chrome.tabs.getCurrent();
  await navigator.locks.request('full-capt', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      await chrome.tabs.remove(resultTab.id);
      return;
    }

    const badge = (text) => chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    await badge('…');
    try {
      const { blob, width, height } = await capturePage(tabId, windowId, (done, total, retry) => {
        const action = retry ? `ページの大きさが変わったため再撮影中（${retry}回目）…` : 'ページを撮影中…';
        status.textContent = `${action} ${done} / ${total}`;
        void badge(`${Math.floor(done / total * 100)}%`);
      });
      const pngUrl = URL.createObjectURL(blob);
      preview.src = pngUrl;
      preview.hidden = false;
      save.href = pngUrl;
      const now = new Date();
      const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()];
      const format = (parts) => parts.map((part) => String(part).padStart(2, '0')).join('-');
      save.download = `full-capt-${format(date)}_${format(time)}.png`;
      const dimensions = `${width} × ${height} px`;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          status.textContent = `クリップボードにコピーしました · ${dimensions}`;
        } catch (error) {
          status.textContent = '画像をコピーできませんでした。「PNGを保存」から画像を保存できます。';
          console.error(error);
        }
      });
      actions.hidden = false;
      status.textContent = `撮影完了 · ${dimensions}`;
      await badge('');
    } catch (error) {
      status.textContent = error instanceof CaptureError
        ? error.message
        : '画像を作成できませんでした。対象ページに戻って撮影をやり直してください。';
      console.error(error);
      await badge('!');
    }

    const [active] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
    if (active?.id === tabId) await chrome.tabs.update(resultTab.id, { active: true });
  });
}

start().catch((error) => {
  status.textContent = '撮影を開始できませんでした。対象ページからもう一度お試しください。';
  console.error(error);
});
