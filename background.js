chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;

  const resultUrl = new URL(chrome.runtime.getURL('result.html'));
  resultUrl.hash = new URLSearchParams({ tab: tab.id, window: tab.windowId });

  try {
    await chrome.tabs.create({ windowId: tab.windowId, url: resultUrl.href, active: false });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
  }
});
