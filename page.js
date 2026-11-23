(() => {
  const stateKey = '__fullCaptPage';
  if (globalThis[stateKey]) return;

  const root = document.documentElement;
  const scroller = document.scrollingElement;
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  const restoreStyles = [];
  const fixed = [];
  let watchdog;
  let fixedHidden = false;

  function setStyle(element, name, value) {
    const hadAttribute = element.getAttribute('style') !== null;
    const { style } = element;
    const previous = style.getPropertyValue(name);
    const priority = style.getPropertyPriority(name);
    style.setProperty(name, value, 'important');
    restoreStyles.push(() => {
      if (style.getPropertyValue(name) !== value || style.getPropertyPriority(name) !== 'important') return;
      if (previous) style.setProperty(name, previous, priority);
      else style.removeProperty(name);
      if (!hadAttribute && element.getAttribute('style') === '') element.removeAttribute('style');
    });
  }

  function restore() {
    clearTimeout(watchdog);
    delete globalThis[stateKey];
    for (const restoreStyle of restoreStyles.reverse()) restoreStyle();
    window.scrollTo({ left: originalX, top: originalY, behavior: 'instant' });
  }

  function rearm() {
    clearTimeout(watchdog);
    // Restore the source page even if the user closes the result tab mid-capture.
    watchdog = setTimeout(restore, 15000);
  }

  function read() {
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const width = Math.max(viewWidth, scroller.scrollWidth);
    const height = Math.max(viewHeight, scroller.scrollHeight);
    const left = getComputedStyle(scroller).direction === 'rtl' ? viewWidth - width : 0;
    return {
      width, height, viewWidth, viewHeight, left,
      x: window.scrollX - left, y: window.scrollY, dpr: window.devicePixelRatio,
    };
  }

  try {
    setStyle(root, 'scrollbar-width', 'none');
    for (const element of new Set([root, scroller])) {
      setStyle(element, 'scroll-snap-type', 'none');
      setStyle(element, 'overflow-anchor', 'none');
    }

    for (const element of document.querySelectorAll('*')) {
      const { position, visibility } = getComputedStyle(element);
      if (position === 'sticky') setStyle(element, 'position', 'relative');
      if (position === 'fixed' && visibility === 'visible') fixed.push(element);
    }

    globalThis[stateKey] = {
      inspect() {
        rearm();
        return read();
      },
      async move(x, y, first) {
        rearm();
        if (!first && !fixedHidden) {
          for (const element of fixed) {
            setStyle(element, 'transition-property', 'none');
            setStyle(element, 'opacity', '0');
          }
          fixedHidden = true;
        }
        window.scrollTo({ left: x + read().left, top: y, behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 160));

        const pendingImages = Array.from(document.images).filter((image) => {
          if (image.complete) return false;
          const bounds = image.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 &&
            bounds.top < window.innerHeight && bounds.left < window.innerWidth;
        });
        if (pendingImages.length) {
          await Promise.race([
            Promise.allSettled(pendingImages.map((image) => image.decode())),
            new Promise((resolve) => setTimeout(resolve, 650)),
          ]);
        }
        return read();
      },
      restore,
    };
    rearm();
  } catch (error) {
    restore();
    throw error;
  }
})();
