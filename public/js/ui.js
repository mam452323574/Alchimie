(() => {
  const csrfToken = document.querySelector('#csrf-token-carrier input[name="csrf_token"]')?.value || '';
  document.querySelectorAll('form[method]').forEach((form) => {
    if (String(form.method).toLowerCase() !== 'post' || form.querySelector('input[name="csrf_token"]')) return;
    const tokenField = document.createElement('input');
    tokenField.type = 'hidden';
    tokenField.name = 'csrf_token';
    tokenField.value = csrfToken;
    form.prepend(tokenField);
  });

  const siteHeader = document.querySelector('.site-header');
  const mobileMenuToggle = document.querySelector('[data-mobile-menu-toggle]');
  const closeMobileMenu = () => {
    if (!siteHeader || !mobileMenuToggle) return;
    siteHeader.classList.remove('mobile-menu-open');
    mobileMenuToggle.setAttribute('aria-expanded', 'false');
    mobileMenuToggle.setAttribute('aria-label', 'Ouvrir le menu');
  };
  if (siteHeader && mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', () => {
      const isOpen = siteHeader.classList.toggle('mobile-menu-open');
      mobileMenuToggle.setAttribute('aria-expanded', String(isOpen));
      mobileMenuToggle.setAttribute('aria-label', isOpen ? 'Fermer le menu' : 'Ouvrir le menu');
    });
    siteHeader.querySelectorAll('.main-nav a').forEach((link) => link.addEventListener('click', closeMobileMenu));
    window.matchMedia('(min-width: 761px)').addEventListener('change', (event) => {
      if (event.matches) closeMobileMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMobileMenu();
    });
  }

  const toast = document.querySelector('[data-toast]');
  if (toast) {
    const close = () => toast.classList.add('toast-hidden');
    toast.querySelector('[data-toast-close]').addEventListener('click', close);
    window.setTimeout(close, 4200);
  }

  const updateMembershipDays = () => {
    document.querySelectorAll('[data-membership-days]').forEach((counter) => {
      const rawDate = String(counter.dataset.createdAt || '').trim();
      if (!rawDate) return;
      const createdAt = Date.parse(rawDate.includes('T') ? rawDate : `${rawDate.replace(' ', 'T')}Z`);
      if (!Number.isFinite(createdAt)) return;
      const days = Math.max(0, Math.floor((Date.now() - createdAt) / 86400000));
      counter.textContent = `${days} jour${days > 1 ? 's' : ''}`;
    });
  };
  updateMembershipDays();
  if (document.querySelector('[data-membership-days]')) window.setInterval(updateMembershipDays, 60000);

  const privateLink = document.querySelector('[data-private-message-link]');
  const setPrivateMessageUnread = (unreadPrivateMessages = 0) => {
    if (!privateLink) return;
    privateLink.classList.toggle('private-message-unread', unreadPrivateMessages > 0);
    if (unreadPrivateMessages > 0) {
      const label = `Messages privés - ${unreadPrivateMessages} conversation${unreadPrivateMessages > 1 ? 's' : ''} non lue${unreadPrivateMessages > 1 ? 's' : ''}`;
      privateLink.setAttribute('aria-label', label);
      privateLink.setAttribute('title', label);
    } else {
      privateLink.setAttribute('aria-label', 'Messages privés');
      privateLink.setAttribute('title', 'Messages privés');
    }
  };
  window.avebarSetPrivateUnread = setPrivateMessageUnread;

  const updatePresence = async () => {
    try {
      const response = await fetch('/presence', {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
        keepalive: true,
      });
      if (!response.ok) return;
      const { online, unreadPrivateMessages = 0 } = await response.json();
      document.querySelectorAll('[data-online-count]').forEach((counter) => { counter.textContent = online; });
      document.querySelectorAll('[data-online-label]').forEach((label) => {
        label.textContent = ` connecté${online > 1 ? 's' : ''} en ce moment`;
      });
      setPrivateMessageUnread(unreadPrivateMessages);
    } catch { /* le prochain signal actualisera le compteur */ }
  };
  updatePresence();
  window.setInterval(updatePresence, 15000);

  if (privateLink && 'EventSource' in window) {
    const privateMessageStream = new EventSource('/flux/messages');
    privateMessageStream.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setPrivateMessageUnread(payload.unreadPrivateMessages || 0);
        if (payload.kind === 'message') {
          window.dispatchEvent(new CustomEvent('avebar:private-message', { detail: payload }));
        } else if (payload.kind === 'typing') {
          window.dispatchEvent(new CustomEvent('avebar:private-typing', { detail: payload }));
        }
      } catch { /* le flux se reconnectera si le message est incomplet */ }
    });
    window.addEventListener('beforeunload', () => privateMessageStream.close(), { once: true });
  }

  const trigger = document.querySelector('[data-notification-trigger]');
  const popover = document.querySelector('[data-notification-popover]');
  if (trigger && popover) trigger.addEventListener('click', async () => {
    const willOpen = popover.hidden;
    popover.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      const count = trigger.querySelector('[data-notification-count]');
      if (count) count.remove();
      popover.querySelectorAll('.notification-new').forEach((item) => item.classList.remove('notification-new'));
      try { await fetch('/notifications/lues', { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken } }); } catch { /* prochaine ouverture */ }
    }
  });
  document.addEventListener('click', (event) => {
    if (trigger && popover && !popover.hidden && !popover.contains(event.target) && !trigger.contains(event.target)) {
      popover.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
})();
