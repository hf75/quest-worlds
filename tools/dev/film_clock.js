// Läuft vor allem anderen auf der Seite. Sie kennt dann nur noch diese Uhr: Für die Aufnahme bleibt die Zeit stehen, bis film.js das nächste Bild anfordert.
// So entsteht ein gleichmäßiger Film, egal wie lange ein Bild wirklich dauert. Außerhalb der Aufnahme läuft die Uhr einfach mit.
(() => {
  const realNow = performance.now.bind(performance);
  const queue = [];
  let now = realNow();
  let last = now;
  const clock = {
    auto: true,
    step(ms) {
      now += ms;
      for (const callback of queue.splice(0)) callback(now);
    },
  };
  performance.now = () => now;
  window.requestAnimationFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  setInterval(() => {
    const t = realNow();
    if (clock.auto) clock.step(t - last);
    last = t;
  }, 16);
  window.__clock = clock;
  // Die Aufnahme hat immer dieselbe Größe, wie groß das Fenster auch ist. Der Emulator richtet seine Zeichenfläche danach.
  const size = { width: 2560, height: 1440 };
  Object.defineProperty(window, 'innerWidth', { get: () => size.width });
  Object.defineProperty(window, 'innerHeight', { get: () => size.height });
})();
