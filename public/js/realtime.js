(() => {
  const appendHtml = (container, html) => {
    if (!html) return [];
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const added = [];
    [...template.content.children].forEach((element) => {
      if (element.id && document.getElementById(element.id)) return;
      element.classList.add('realtime-arrival');
      added.push(container.appendChild(element));
    });
    return added;
  };

  const showNewMessage = (root, count, href) => {
    const notice = root.querySelector('[data-realtime-new-message]');
    if (!notice || count < 1) return;
    notice.textContent = `${count} nouveau${count > 1 ? 'x' : ''} message${count > 1 ? 's' : ''} - afficher`;
    notice.href = href;
    notice.hidden = false;
    notice.onclick = () => { notice.hidden = true; };
  };

  const setPrivateUnread = (count) => {
    if (typeof window.avebarSetPrivateUnread === 'function') window.avebarSetPrivateUnread(count);
  };

  const createTypingDisplay = (root) => {
    const indicator = root?.querySelector('[data-typing-indicator]');
    const text = indicator?.querySelector('[data-typing-text]');
    const typers = new Map();
    const render = () => {
      if (!indicator || !text) return;
      const names = [...typers.values()].map((entry) => entry.username);
      indicator.hidden = names.length === 0;
      if (names.length === 1) text.textContent = `${names[0]} est en train d’écrire`;
      else if (names.length === 2) text.textContent = `${names[0]} et ${names[1]} sont en train d’écrire`;
      else if (names.length > 2) text.textContent = `${names[0]}, ${names[1]} et ${names.length - 2} autre${names.length > 3 ? 's' : ''} sont en train d’écrire`;
    };
    return (payload) => {
      const userId = Number(payload.userId);
      if (!userId) return;
      const previous = typers.get(userId);
      if (previous?.timer) window.clearTimeout(previous.timer);
      if (payload.active) {
        const timer = window.setTimeout(() => { typers.delete(userId); render(); }, 7000);
        typers.set(userId, { username: payload.username || 'Un membre', timer });
      } else {
        typers.delete(userId);
      }
      render();
    };
  };

  const attachTypingSender = (form, endpoint) => {
    const input = form?.querySelector('[data-editor-input]');
    if (!form || !input) return () => {};
    const csrfToken = form.querySelector('input[name="csrf_token"]')?.value || '';
    let active = false;
    let lastSignalAt = 0;
    let idleTimer = null;
    const send = (isActive) => {
      const body = new URLSearchParams({ active: isActive ? '1' : '0' });
      if (csrfToken) body.set('csrf_token', csrfToken);
      fetch(endpoint, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json', 'X-AveBar-Realtime': '1' },
        keepalive: true,
      }).catch(() => {});
    };
    const stop = () => {
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = null;
      if (active) send(false);
      active = false;
      lastSignalAt = 0;
    };
    input.addEventListener('input', () => {
      if (!input.value.trim()) { stop(); return; }
      const now = Date.now();
      if (!active || now - lastSignalAt > 2200) {
        send(true);
        active = true;
        lastSignalAt = now;
      }
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(stop, 1900);
    });
    window.addEventListener('pagehide', stop, { once: true });
    return stop;
  };

  const publicPanel = document.querySelector('[data-realtime-thread]');
  let refreshPublicMessages = null;
  if (publicPanel && 'EventSource' in window) {
    const threadId = Number(publicPanel.dataset.threadId);
    const messageList = publicPanel.querySelector('[data-realtime-message-list]');
    let currentPage = Number(publicPanel.dataset.currentPage);
    let lastMessageId = Number(publicPanel.dataset.lastMessageId || 0);
    let refreshing = false;
    let refreshAgain = false;
    const updatePublicTyping = createTypingDisplay(publicPanel);

    refreshPublicMessages = async () => {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const nearBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 420;
        const response = await fetch(`/t/${threadId}/nouveaux-messages?apres=${lastMessageId}&page=${currentPage}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Actualisation indisponible');
        const payload = await response.json();
        publicPanel.dataset.totalPages = payload.totalPages;
        if (!payload.append) {
          showNewMessage(publicPanel, payload.newCount, `/t/${threadId}?page=${payload.totalPages}#post-${payload.latestMessageId}`);
          return;
        }
        const added = appendHtml(messageList, payload.html);
        lastMessageId = Math.max(lastMessageId, Number(payload.latestMessageId || 0));
        publicPanel.dataset.lastMessageId = lastMessageId;
        if (!added.length) return;
        const destination = `#${added[added.length - 1].id}`;
        if (nearBottom) added[added.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
        else showNewMessage(publicPanel, added.length, destination);
      } catch { /* le flux tentera une nouvelle actualisation */ }
      finally {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; refreshPublicMessages(); }
      }
    };

    const publicStream = new EventSource(`/flux/t/${threadId}`);
    publicStream.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.kind === 'message') {
          updatePublicTyping({ userId: payload.senderId, active: false });
          refreshPublicMessages();
        } else if (payload.kind === 'typing') updatePublicTyping(payload);
      } catch { /* le prochain événement réessaiera */ }
    });
    window.addEventListener('beforeunload', () => publicStream.close(), { once: true });
  }

  const privateConversation = document.querySelector('[data-realtime-private-conversation]');
  let refreshPrivateMessages = null;
  if (privateConversation) {
    const conversationId = Number(privateConversation.dataset.conversationId);
    const messageList = privateConversation.querySelector('[data-realtime-message-list]');
    let currentPage = Number(privateConversation.dataset.currentPage);
    let lastMessageId = Number(privateConversation.dataset.lastMessageId || 0);
    let refreshing = false;
    let refreshAgain = false;
    const updatePrivateTyping = createTypingDisplay(privateConversation);

    refreshPrivateMessages = async () => {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const nearBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 420;
        const response = await fetch(`/messages/${conversationId}/nouveaux-messages?apres=${lastMessageId}&page=${currentPage}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Actualisation privée indisponible');
        const payload = await response.json();
        setPrivateUnread(payload.unreadPrivateMessages || 0);
        privateConversation.dataset.totalPages = payload.totalPages;
        if (!payload.append) {
          showNewMessage(privateConversation, payload.newCount, `/messages/${conversationId}?page=${payload.totalPages}#mp-${payload.latestMessageId}`);
          return;
        }
        const added = appendHtml(messageList, payload.html);
        lastMessageId = Math.max(lastMessageId, Number(payload.latestMessageId || 0));
        privateConversation.dataset.lastMessageId = lastMessageId;
        if (!added.length) return;
        const destination = `#${added[added.length - 1].id}`;
        if (nearBottom) added[added.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
        else showNewMessage(privateConversation, added.length, destination);
      } catch { /* le flux tentera une nouvelle actualisation */ }
      finally {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; refreshPrivateMessages(); }
      }
    };

    window.addEventListener('avebar:private-message', (event) => {
      if (Number(event.detail.conversationId) === conversationId) {
        updatePrivateTyping({ userId: event.detail.senderId, active: false });
        refreshPrivateMessages();
      }
    });
    window.addEventListener('avebar:private-typing', (event) => {
      if (Number(event.detail.conversationId) === conversationId) updatePrivateTyping(event.detail);
    });
  }

  const privateInbox = document.querySelector('[data-realtime-private-inbox]');
  if (privateInbox) {
    let refreshingInbox = false;
    const refreshInbox = async () => {
      if (refreshingInbox) return;
      refreshingInbox = true;
      try {
        const response = await fetch('/messages/liste-fragment', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Actualisation indisponible');
        const payload = await response.json();
        privateInbox.innerHTML = payload.html;
        setPrivateUnread(payload.unreadPrivateMessages || 0);
      } catch { /* le flux tentera une nouvelle actualisation */ }
      finally { refreshingInbox = false; }
    };
    window.addEventListener('avebar:private-message', refreshInbox);
  }

  const submitRealtimeForm = (form, afterSuccess, stopTyping) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      stopTyping?.();
      const submit = form.querySelector('button[type="submit"]');
      const feedback = form.querySelector('[data-realtime-form-feedback]');
      const originalLabel = submit?.textContent;
      if (submit) { submit.disabled = true; submit.textContent = 'Envoi…'; }
      if (feedback) feedback.hidden = true;
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          body: new URLSearchParams(new FormData(form)),
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({ error: 'La session a expiré. Recharge la page.' }));
        if (!response.ok) throw new Error(payload.error || 'Envoi impossible.');
        form.reset();
        form.querySelector('[data-reply-target]')?.setAttribute('hidden', '');
        form.querySelector('[data-editor-preview]')?.setAttribute('hidden', '');
        const pollFields = form.querySelector('.poll-fields');
        if (pollFields) pollFields.hidden = true;
        if (feedback) {
          feedback.textContent = payload.message || 'Message envoyé.';
          feedback.classList.remove('is-error');
          feedback.hidden = false;
        }
        await afterSuccess?.(payload);
      } catch (error) {
        if (feedback) {
          feedback.textContent = error.message;
          feedback.classList.add('is-error');
          feedback.hidden = false;
        }
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = originalLabel; }
      }
    });
  };

  const publicReplyForm = document.querySelector('[data-realtime-public-reply]');
  if (publicReplyForm) {
    const stopPublicTyping = attachTypingSender(publicReplyForm, `/flux/t/${publicPanel.dataset.threadId}/ecriture`);
    submitRealtimeForm(publicReplyForm, () => refreshPublicMessages?.(), stopPublicTyping);
  }
  const privateReplyForm = document.querySelector('[data-realtime-private-reply]');
  if (privateReplyForm) {
    const stopPrivateTyping = attachTypingSender(privateReplyForm, `/flux/messages/${privateConversation.dataset.conversationId}/ecriture`);
    submitRealtimeForm(privateReplyForm, () => refreshPrivateMessages?.(), stopPrivateTyping);
  }
})();
