(() => {
  const terminal = document.getElementById('server-terminal');
  if (!terminal) return;
  const formatBytes = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Gio`;
  async function refresh() {
    try {
      const response = await fetch('/developpeur/etat', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Accès refusé');
      const state = await response.json();
      const activity = state.activity.map((item) => `[${item.created_at}] ${item.action} - ${item.details || 'aucun détail'}`).join('\n');
      terminal.textContent = [
        `$ forum status --watch`, ``,
        `Heure serveur  ${state.now}`,
        `Hôte            ${state.hostname}`,
        `Système         ${state.platform}`,
        `Node.js         ${state.process.node}`,
        `Processus       PID ${state.process.pid} · actif ${state.process.uptimeSeconds}s`,
        `VPS             actif ${state.uptimeSeconds}s`,
        `Charge          ${state.loadAverage.join(' / ')}`,
        `Mémoire         ${formatBytes(state.memory.total - state.memory.free)} / ${formatBytes(state.memory.total)}`,
        ``, `- Activité récente -`, activity || 'Aucune action récente.', ``,
        `Actualisation automatique toutes les 5 secondes.`,
      ].join('\n');
    } catch (error) {
      terminal.textContent = `Moniteur indisponible : ${error.message}`;
    }
  }
  refresh();
  window.setInterval(refresh, 5000);
})();
