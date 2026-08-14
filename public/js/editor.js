(() => {
  const form = document.querySelector('[data-editor-form]');
  if (!form) return;
  const input = form.querySelector('[data-editor-input]');
  const preview = form.querySelector('[data-editor-preview]');
  const previewContent = form.querySelector('[data-editor-preview-content]');

  function replaceSelection(before, after = before) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end) || 'texte';
    input.setRangeText(`${before}${selected}${after}`, start, end, 'end');
    input.focus();
  }

  form.querySelectorAll('[data-editor-wrap]').forEach((button) => {
    button.addEventListener('click', () => {
      const tag = button.dataset.editorWrap;
      replaceSelection(`[${tag}]`, `[/${tag}]`);
    });
  });
  form.querySelectorAll('[data-editor-insert]').forEach((button) => {
    button.addEventListener('click', () => {
      const point = input.selectionStart;
      input.setRangeText(button.dataset.editorInsert, point, input.selectionEnd, 'end');
      input.focus();
    });
  });
  form.querySelector('[data-editor-spoiler]').addEventListener('click', () => {
    replaceSelection('<spoiler>', '</spoiler>');
  });
  const colorPicker = form.querySelector('[data-editor-color-picker]');
  const colorToggle = colorPicker?.querySelector('[data-editor-color-toggle]');
  const colorPopover = colorPicker?.querySelector('[data-editor-color-popover]');
  const colorInput = colorPicker?.querySelector('[data-editor-color-input]');
  const colorOutput = colorPicker?.querySelector('[data-editor-color-output]');
  const colorIndicator = colorPicker?.querySelector('[data-editor-color-indicator]');

  function closeColorPicker() {
    if (!colorPopover || !colorToggle) return;
    colorPopover.hidden = true;
    colorToggle.setAttribute('aria-expanded', 'false');
  }

  function applyColor(rawColor) {
    const color = String(rawColor || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(color)) return;
    replaceSelection(`[color=${color}]`, '[/color]');
    if (colorInput) colorInput.value = color.toLowerCase();
    if (colorOutput) colorOutput.textContent = color;
    if (colorIndicator) colorIndicator.style.textDecorationColor = color;
    closeColorPicker();
  }

  const emojiCategories = [
    { id: 'faces', label: 'Visages', icon: '😀', emojis: ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😋','😛','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😢','😭','😤','😡','🤬','🤯','😳','🥺','😱','🤗','🤔','🤭','🤫','😴','🤤','🤢','🤮','🤧'] },
    { id: 'gestures', label: 'Gestes', icon: '👋', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🖕'] },
    { id: 'hearts', label: 'Cœurs', icon: '❤️', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','🫶','🫂','💋','💌','💐','🌹','🥀','🌷','🌸','🌺','🌻'] },
    { id: 'nature', label: 'Nature', icon: '🐱', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦄','🐝','🦋','🐌','🐞','🌲','🌳','🌴','🌵','🍀','🍁','🍂','🌍','🌙','⭐','☀️','🌈','🔥','❄️'] },
    { id: 'food', label: 'Nourriture', icon: '🍕', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🍆','🥕','🌽','🥐','🥖','🧀','🍔','🍟','🍕','🌭','🥪','🌮','🍿','🍣','🍜','🍩','🍪','🎂','🍫','☕','🍺','🍷','🥤'] },
    { id: 'activities', label: 'Activités', icon: '⚽', emojis: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥅','⛳','🏹','🎣','🥊','🎽','🛹','⛸️','🎿','🏆','🥇','🎯','🎮','🕹️','🎲','♟️','🎭','🎨','🎬','🎤','🎧','🎸','🎹','🥁','🎺','📚','✈️','🚗','🚲','🚀'] },
    { id: 'objects', label: 'Objets', icon: '💡', emojis: ['⌚','📱','💻','⌨️','🖥️','🖨️','📷','📹','📺','📻','🎙️','⏰','💡','🔦','🕯️','🧭','🎁','🎈','🧸','🛒','✉️','📩','📦','📌','📍','📎','✂️','✏️','🔒','🔑','🔨','🧰','🧲','🧪','💊','🩹','🚪','🪑','🛏️','🚿'] },
    { id: 'symbols', label: 'Symboles', icon: '✅', emojis: ['✅','❌','⭕','🛑','⛔','⚠️','❗','❓','‼️','⁉️','💯','💢','💥','💫','💦','💨','💤','🎵','🎶','➕','➖','➗','✖️','♾️','✔️','☑️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🏳️','🏴','🏁','🚩','🇫🇷','🇪🇺'] },
  ];
  const emojiPicker = form.querySelector('[data-editor-emoji-picker]');
  const emojiToggle = emojiPicker?.querySelector('[data-editor-emoji-toggle]');
  const emojiPopover = emojiPicker?.querySelector('[data-editor-emoji-popover]');
  const emojiCategoryName = emojiPicker?.querySelector('[data-editor-emoji-category-name]');
  const emojiCategoryList = emojiPicker?.querySelector('[data-editor-emoji-categories]');
  const emojiGrid = emojiPicker?.querySelector('[data-editor-emoji-grid]');

  function insertEmoji(emoji) {
    const point = input.selectionStart;
    input.setRangeText(emoji, point, input.selectionEnd, 'end');
    input.focus();
  }

  function renderEmojiCategory(categoryId) {
    const category = emojiCategories.find((item) => item.id === categoryId) || emojiCategories[0];
    emojiCategoryName.textContent = category.label;
    emojiCategoryList.querySelectorAll('[data-emoji-category]').forEach((button) => {
      const selected = button.dataset.emojiCategory === category.id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    emojiGrid.replaceChildren();
    category.emojis.forEach((emoji) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-label', `Insérer ${emoji}`);
      button.addEventListener('click', () => insertEmoji(emoji));
      emojiGrid.appendChild(button);
    });
  }

  function closeEmojiPicker() {
    if (!emojiPopover || !emojiToggle) return;
    emojiPopover.hidden = true;
    emojiToggle.setAttribute('aria-expanded', 'false');
  }

  if (emojiCategoryList && emojiGrid) {
    emojiCategories.forEach((category) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = category.icon;
      button.dataset.emojiCategory = category.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-label', category.label);
      button.title = category.label;
      button.addEventListener('click', () => renderEmojiCategory(category.id));
      emojiCategoryList.appendChild(button);
    });
    renderEmojiCategory(emojiCategories[0].id);
  }

  emojiToggle?.addEventListener('click', () => {
    const willOpen = emojiPopover.hidden;
    closeColorPicker();
    emojiPopover.hidden = !willOpen;
    emojiToggle.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) emojiGrid.querySelector('button')?.focus();
  });
  emojiPicker?.querySelector('[data-editor-emoji-close]')?.addEventListener('click', () => {
    closeEmojiPicker();
    emojiToggle.focus();
  });

  colorToggle?.addEventListener('click', () => {
    const willOpen = colorPopover.hidden;
    closeEmojiPicker();
    colorPopover.hidden = !willOpen;
    colorToggle.setAttribute('aria-expanded', String(willOpen));
  });
  colorPicker?.querySelectorAll('[data-editor-color-value]').forEach((button) => {
    button.addEventListener('click', () => applyColor(button.dataset.editorColorValue));
  });
  colorInput?.addEventListener('input', () => {
    const color = colorInput.value.toUpperCase();
    colorOutput.textContent = color;
    colorIndicator.style.textDecorationColor = color;
  });
  colorPicker?.querySelector('[data-editor-color-apply]')?.addEventListener('click', () => applyColor(colorInput.value));
  document.addEventListener('click', (event) => {
    if (colorPicker && !colorPicker.contains(event.target)) closeColorPicker();
    if (emojiPicker && !emojiPicker.contains(event.target)) closeEmojiPicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeColorPicker(); closeEmojiPicker(); }
  });
  form.querySelector('[data-editor-image]')?.addEventListener('click', () => {
    const url = window.prompt("Adresse HTTPS de l'image ou lien direct Imgur :", 'https://');
    if (url && /^https:\/\//i.test(url)) {
      const point = input.selectionStart;
      input.setRangeText(`[img]${url}[/img]`, point, input.selectionEnd, 'end');
      input.focus();
    }
  });

  const risiBankButton = form.querySelector('[data-editor-risibank]');
  const risiBankOrigin = 'https://risibank.fr';
  const risiBankIntegrationId = 617304;
  let risiBankPicker = null;
  let risiBankFrame = null;
  let risiBankPreviousFocus = null;

  function validatedRisiBankUrl(media) {
    if (!media || typeof media !== 'object' || typeof media.cache_url !== 'string') return null;
    try {
      const url = new URL(media.cache_url);
      if (url.origin !== risiBankOrigin) return null;
      if (!/^\/cache\/medias\/\d+\/\d+\/\d+\/\d+\/[a-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) return null;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (_error) {
      return null;
    }
  }

  function insertSticker(url) {
    const point = input.selectionStart;
    input.setRangeText(`[sticker]${url}[/sticker]`, point, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    setUploadStatus('Sticker ajouté');
    window.setTimeout(() => setUploadStatus(''), 2500);
  }

  function closeRisiBankPicker({ restoreFocus = true } = {}) {
    if (!risiBankPicker || risiBankPicker.hidden) return;
    risiBankPicker.hidden = true;
    risiBankFrame?.remove();
    risiBankFrame = null;
    document.documentElement.classList.remove('has-open-picker');
    if (restoreFocus) (risiBankPreviousFocus || risiBankButton)?.focus();
  }

  function ensureRisiBankPicker() {
    if (risiBankPicker) return risiBankPicker;
    risiBankPicker = document.createElement('section');
    risiBankPicker.className = 'risibank-picker';
    risiBankPicker.hidden = true;
    risiBankPicker.setAttribute('role', 'dialog');
    risiBankPicker.setAttribute('aria-modal', 'true');
    risiBankPicker.setAttribute('aria-labelledby', 'risibank-picker-title');
    risiBankPicker.innerHTML = `
      <div class="risibank-picker-panel">
        <header class="risibank-picker-head">
          <div><strong id="risibank-picker-title">Stickers RisiBank</strong><span>La sélection reste isolée du contenu de ton message</span></div>
          <button type="button" class="risibank-picker-close" aria-label="Fermer RisiBank">×</button>
        </header>
        <div class="risibank-picker-body"><p class="risibank-picker-status">Chargement de RisiBank…</p></div>
      </div>`;
    risiBankPicker.querySelector('.risibank-picker-close').addEventListener('click', () => closeRisiBankPicker());
    risiBankPicker.addEventListener('click', (event) => {
      if (event.target === risiBankPicker) closeRisiBankPicker();
    });
    document.body.appendChild(risiBankPicker);
    return risiBankPicker;
  }

  function openRisiBankPicker() {
    const picker = ensureRisiBankPicker();
    const body = picker.querySelector('.risibank-picker-body');
    const status = picker.querySelector('.risibank-picker-status');
    risiBankPreviousFocus = document.activeElement;
    risiBankFrame?.remove();
    risiBankFrame = document.createElement('iframe');
    const parameters = new URLSearchParams({
      id: String(risiBankIntegrationId),
      theme: 'dark',
      allowUsernameSelection: 'false',
      showCopyButton: 'false',
      mediaSize: 'md',
      navbarSize: 'md',
      defaultTab: 'search',
      showNSFW: 'false',
      showCloseButton: 'false',
    });
    risiBankFrame.src = `${risiBankOrigin}/embed?${parameters}`;
    risiBankFrame.title = 'Sélecteur de stickers RisiBank';
    risiBankFrame.referrerPolicy = 'no-referrer';
    // RisiBank reste dans une iframe d’origine distincte : son JavaScript ne
    // peut donc pas lire le DOM, les champs ou les cookies d’Alchimie. Pas de
    // navigation du parent, de pop-up ni de permissions supplémentaires.
    risiBankFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    risiBankFrame.addEventListener('load', () => { status.hidden = true; });
    status.hidden = false;
    body.appendChild(risiBankFrame);
    picker.hidden = false;
    document.documentElement.classList.add('has-open-picker');
    picker.querySelector('.risibank-picker-close').focus();
  }

  risiBankButton?.addEventListener('click', openRisiBankPicker);
  window.addEventListener('message', (event) => {
    // Triple verrou : origine exacte, fenêtre source exacte et identifiant
    // d’intégration. Le contenu du message n’est jamais transmis à RisiBank.
    if (!risiBankFrame || event.origin !== risiBankOrigin || event.source !== risiBankFrame.contentWindow) return;
    const payload = event.data;
    if (!payload || Number(payload.id) !== risiBankIntegrationId) return;
    if (payload.type === 'risibank-closed') {
      closeRisiBankPicker();
      return;
    }
    if (payload.type !== 'risibank-media-selected') return;
    const url = validatedRisiBankUrl(payload.media);
    if (!url) {
      setUploadStatus('Sticker refusé', true);
      return;
    }
    closeRisiBankPicker({ restoreFocus: false });
    insertSticker(url);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && risiBankPicker && !risiBankPicker.hidden) closeRisiBankPicker();
  });

  const uploadButton = form.querySelector('[data-editor-upload]');
  const uploadInput = form.querySelector('[data-editor-upload-input]');
  const uploadStatus = form.querySelector('[data-editor-upload-status]');
  const uploadCsrf = form.querySelector('[data-editor-upload-csrf]')?.value || '';
  const supportedImages = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  function setUploadStatus(message, isError = false) {
    if (!uploadStatus) return;
    uploadStatus.textContent = message;
    uploadStatus.classList.toggle('is-error', isError);
  }

  uploadButton?.addEventListener('click', () => uploadInput?.click());
  uploadInput?.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (!file) return;
    if (!supportedImages.includes(file.type)) {
      setUploadStatus('Format refusé', true);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadStatus('Maximum 5 Mo', true);
      return;
    }
    const privateComposer = form.dataset.uploadScope === 'private' || window.location.pathname.startsWith('/messages');
    const conversationId = form.dataset.uploadConversationId || window.location.pathname.match(/^\/messages\/(\d+)/)?.[1] || '';
    const parameters = new URLSearchParams({ scope: privateComposer ? 'private' : 'public' });
    if (privateComposer && conversationId) parameters.set('conversation_id', conversationId);
    uploadButton.disabled = true;
    setUploadStatus('Envoi…');
    try {
      const response = await fetch(`/api/images?${parameters}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': file.type,
          'X-CSRF-Token': uploadCsrf,
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = await response.json().catch(() => ({ error: 'Upload impossible.' }));
      if (!response.ok) throw new Error(payload.error || 'Upload impossible.');
      const point = input.selectionStart;
      input.setRangeText(`[img]${payload.url}[/img]`, point, input.selectionEnd, 'end');
      input.focus();
      setUploadStatus('Image ajoutée');
      window.setTimeout(() => setUploadStatus(''), 2500);
    } catch (error) {
      setUploadStatus(error.message, true);
    } finally {
      uploadButton.disabled = false;
    }
  });

  function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function previewMedia(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (_error) { return escapeHtml(rawUrl); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return escapeHtml(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const noelshackUrl = normalizedNoelshackUrl(url.toString());
    if (noelshackUrl) return `<img class="post-sticker-image" src="${escapeHtml(noelshackUrl)}" alt="Aperçu du sticker">`;
    let youtubeId = '';
    if (host === 'youtu.be') youtubeId = url.pathname.split('/').filter(Boolean)[0] || '';
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      youtubeId = url.pathname === '/watch'
        ? (url.searchParams.get('v') || '')
        : (url.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]+)/)?.[1] || '');
    }
    if (/^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) {
      return `<iframe class="post-media-embed post-youtube-embed" src="https://www.youtube-nocookie.com/embed/${youtubeId}" title="Vidéo YouTube"></iframe>`;
    }
    const tiktokId = host === 'tiktok.com' ? url.pathname.match(/\/video\/(\d{10,30})(?:\/|$)/)?.[1] : '';
    if (tiktokId) return `<iframe class="post-media-embed post-tiktok-embed" src="https://www.tiktok.com/player/v1/${tiktokId}?autoplay=0&amp;description=1" title="Vidéo TikTok"></iframe>`;
    const vocarooId = host === 'vocaroo.com' ? url.pathname.match(/^\/([a-zA-Z0-9]{6,32})\/?$/)?.[1] : '';
    if (vocarooId) {
      return `<div class="post-vocaroo-embed" style="left:0;width:100%;height:60px;position:relative;"><iframe src="https://vocaroo.com/embed/${vocarooId}" style="top:0;left:0;width:100%;height:100%;position:absolute;border:0;" title="Enregistrement audio Vocaroo" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin" allowfullscreen></iframe></div>`;
    }
    const escaped = escapeHtml(url.toString());
    if (['i.imgur.com', 'imgur.com'].includes(host) && /\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) {
      return `<img class="post-inline-image" src="${escaped}" alt="Aperçu de l’image">`;
    }
    return `<a class="post-auto-link" href="${escaped}" target="_blank" rel="noopener noreferrer">${escaped}</a>`;
  }
  function normalizedNoelshackUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (_error) { return null; }
    const host = url.hostname.toLowerCase();
    const direct = url.pathname.match(/^\/(?:fichiers|minis)\/\d{4}\/\d{1,2}\/(?:\d\/)?[^/]+\.(?:png|jpe?g|gif|webp)$/i);
    if (host === 'image.noelshack.com' && direct) {
      url.protocol = 'https:';
      url.port = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    }
    if (!['noelshack.com', 'www.noelshack.com'].includes(host)) return null;
    const currentViewer = url.pathname.match(/^\/(\d{4})-(\d{1,2})-([1-7])-(\d{8,}-.+\.(?:png|jpe?g|gif|webp))$/i);
    if (currentViewer) return `https://image.noelshack.com/fichiers/${currentViewer[1]}/${currentViewer[2].padStart(2, '0')}/${currentViewer[3]}/${currentViewer[4]}`;
    const legacyViewer = url.pathname.match(/^\/(\d{4})-(\d{1,2})-(\d{8,}-.+\.(?:png|jpe?g|gif|webp))$/i);
    if (!legacyViewer) return null;
    return `https://image.noelshack.com/fichiers/${legacyViewer[1]}/${legacyViewer[2].padStart(2, '0')}/${legacyViewer[3]}`;
  }
  function previewSticker(rawUrl) {
    const noelshackUrl = normalizedNoelshackUrl(rawUrl);
    let value = noelshackUrl;
    if (!value) {
      try {
        const url = new URL(rawUrl.trim());
        if (url.origin === risiBankOrigin && /^\/cache\/medias\/\d+\/\d+\/\d+\/\d+\/[a-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) value = url.toString();
      } catch (_error) { value = null; }
    }
    return value
      ? `<img class="post-sticker-image" src="${escapeHtml(value)}" alt="Aperçu du sticker">`
      : '<span class="markup-error">[sticker invalide]</span>';
  }
  function previewImage(rawUrl) {
    const value = rawUrl.trim();
    if (/^\/media\/[a-f0-9]{48}$/i.test(value)) return `<img class="post-inline-image" src="${value}" alt="Aperçu de l’image">`;
    const noelshackUrl = normalizedNoelshackUrl(value);
    if (noelshackUrl) return `<img class="post-sticker-image" src="${escapeHtml(noelshackUrl)}" alt="Aperçu du sticker">`;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        ? `<img class="post-inline-image" src="${escapeHtml(url.toString())}" alt="Aperçu de l’image">`
        : '<span class="markup-error">[image invalide]</span>';
    } catch (_error) { return '<span class="markup-error">[image invalide]</span>'; }
  }
  function renderPreview(value) {
    const media = [];
    const saveMedia = (markup) => {
      const token = `AVEBAREMBEDTOKEN${media.length}ENDTOKEN`;
      media.push([token, markup]);
      return token;
    };
    let protectedValue = value.replace(/\[sticker\]([\s\S]*?)\[\/sticker\]/gi, (_, url) => saveMedia(previewSticker(url)));
    protectedValue = protectedValue.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_, url) => saveMedia(previewImage(url)));
    protectedValue = protectedValue.replace(/https?:\/\/[^\s<>\[\]]+/gi, (candidate) => {
      const trailing = candidate.match(/[),.!?;:'"]+$/)?.[0] || '';
      const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
      return `${saveMedia(previewMedia(url))}${trailing}`;
    });
    let html = escapeHtml(protectedValue);
    [['b', 'strong'], ['i', 'em'], ['s', 's'], ['u', 'u']].forEach(([source, target]) => {
      html = html.replace(new RegExp(`\\[${source}\\]([\\s\\S]*?)\\[\\/${source}\\]`, 'gi'), `<${target}>$1</${target}>`);
    });
    html = html.replace(/\[color=(#[0-9a-f]{3,8})\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>');
    html = html.replace(/&lt;spoiler&gt;([\s\S]*?)&lt;\/spoiler&gt;/gi, '<details class="post-spoiler" open><summary>Spoiler</summary>$1</details>');
    html = html.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<details class="post-spoiler" open><summary>Spoiler</summary>$1</details>');
    html = html.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>');
    html = html.replace(/\r?\n/g, '<br>');
    media.forEach(([token, markup]) => { html = html.replaceAll(token, markup); });
    return html;
  }
  form.querySelector('[data-editor-preview-toggle]').addEventListener('click', () => {
    preview.hidden = !preview.hidden;
    if (!preview.hidden) {
      previewContent.innerHTML = renderPreview(input.value || '<span class="muted">Le message est vide.</span>');
      preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
})();
