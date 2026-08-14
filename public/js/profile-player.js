(() => {
  const button = document.querySelector('[data-profile-music-toggle]');
  const frame = document.getElementById('profile-music-frame');
  if (!button || !frame) return;

  let isPlaying = false;
  let pendingPlay = false;

  function sendToPlayer(message) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(JSON.stringify(message), 'https://www.youtube-nocookie.com');
  }

  function renderState(playing) {
    isPlaying = playing;
    button.classList.toggle('is-playing', playing);
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? 'Mettre la musique en pause' : 'Lire la musique du profil');
    button.title = playing ? 'Mettre la musique en pause' : 'Lire la musique du profil';
  }

  button.addEventListener('click', () => {
    const nextState = !isPlaying;
    if (nextState && !frame.src) {
      pendingPlay = true;
      frame.src = frame.dataset.src;
      renderState(true);
      return;
    }
    sendToPlayer({ event: 'command', func: nextState ? 'playVideo' : 'pauseVideo', args: [] });
    renderState(nextState);
  });

  frame.addEventListener('load', () => {
    sendToPlayer({ event: 'listening', id: 'profile-music-frame' });
    sendToPlayer({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
    if (pendingPlay) {
      pendingPlay = false;
      sendToPlayer({ event: 'command', func: 'playVideo', args: [] });
    }
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== 'https://www.youtube-nocookie.com') return;
    let payload = event.data;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return; }
    }
    if (!payload || payload.event !== 'onStateChange') return;
    if (payload.info === 1) renderState(true);
    if (payload.info === 0 || payload.info === 2) renderState(false);
  });
})();
