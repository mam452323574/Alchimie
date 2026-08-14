const sanitizeHtml = require('sanitize-html');

function cleanBody(raw) {
  const withSpoilers = String(raw || '')
    .replace(/<\s*spoiler\s*>/gi, '[spoiler]')
    .replace(/<\s*\/\s*spoiler\s*>/gi, '[/spoiler]');
  return sanitizeHtml(withSpoilers, { allowedTags: [], allowedAttributes: {} }).trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').replace(/&amp;/gi, '&').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function youtubeVideoId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  let videoId = '';
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
    else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]+)/);
      videoId = match?.[1] || '';
    }
  }
  return /^[a-zA-Z0-9_-]{6,20}$/.test(videoId) ? videoId : null;
}

function tiktokVideoId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'tiktok.com') return null;
  return url.pathname.match(/\/video\/(\d{10,30})(?:\/|$)/)?.[1] || null;
}

function vocarooRecordingId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'vocaroo.com') return null;
  return url.pathname.match(/^\/([a-zA-Z0-9]{6,32})\/?$/)?.[1] || null;
}

function directImgurImage(url) {
  const host = url.hostname.toLowerCase();
  return ['i.imgur.com', 'imgur.com', 'www.imgur.com'].includes(host)
    && /\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname);
}

function normalizeNoelshackImage(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const imageExtension = '(?:png|jpe?g|gif|webp)';
  if (host === 'image.noelshack.com') {
    if (!new RegExp(`^/(?:fichiers|minis)/\\d{4}/\\d{1,2}/(?:\\d/)?[^/]+\\.${imageExtension}$`, 'i').test(url.pathname)) return null;
    url.protocol = 'https:';
    url.port = '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url;
  }
  if (!['noelshack.com', 'www.noelshack.com'].includes(host)) return null;
  const currentViewer = url.pathname.match(new RegExp(`^/(\\d{4})-(\\d{1,2})-([1-7])-(\\d{8,}-.+\\.${imageExtension})$`, 'i'));
  if (currentViewer) {
    const [, year, week, day, fileName] = currentViewer;
    return new URL(`https://image.noelshack.com/fichiers/${year}/${week.padStart(2, '0')}/${day}/${fileName}`);
  }
  const legacyViewer = url.pathname.match(new RegExp(`^/(\\d{4})-(\\d{1,2})-(\\d{8,}-.+\\.${imageExtension})$`, 'i'));
  if (!legacyViewer) return null;
  const [, year, week, fileName] = legacyViewer;
  return new URL(`https://image.noelshack.com/fichiers/${year}/${week.padStart(2, '0')}/${fileName}`);
}

function safeRisiBankCacheImage(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url || url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'risibank.fr') return null;
  return /^\/cache\/medias\/\d+\/\d+\/\d+\/\d+\/[a-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname) ? url : null;
}

function safeExternalLink(url) {
  const escapedUrl = escapeHtml(url.toString());
  return `<a class="post-auto-link" href="${escapedUrl}" target="_blank" rel="noopener noreferrer nofollow ugc">${escapedUrl}</a>`;
}

function vocarooMarkup(recordingId) {
  return `<div class="post-vocaroo-embed" style="left:0;width:100%;height:60px;position:relative;"><iframe src="https://vocaroo.com/embed/${recordingId}" style="top:0;left:0;width:100%;height:100%;position:absolute;border:0;" title="Enregistrement audio Vocaroo" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin" allowfullscreen></iframe></div>`;
}

function imageMarkup(rawUrl, { allowExternalEmbeds = true } = {}) {
  const value = String(rawUrl || '').trim();
  if (/^\/media\/[a-f0-9]{48}$/i.test(value)) {
    return `<img class="post-inline-image" src="${escapeHtml(value)}" alt="Image jointe au message" loading="lazy">`;
  }
  const noelshackImage = normalizeNoelshackImage(value);
  if (noelshackImage) return stickerMarkup(noelshackImage.toString(), { allowExternalEmbeds });
  const url = safeUrl(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return '<span class="markup-error">[image invalide]</span>';
  if (!allowExternalEmbeds) return safeExternalLink(url);
  return `<img class="post-inline-image" src="${escapeHtml(url.toString())}" alt="Image jointe au message" loading="lazy">`;
}

function stickerMarkup(rawUrl, { allowExternalEmbeds = true } = {}) {
  const url = normalizeNoelshackImage(rawUrl) || safeRisiBankCacheImage(rawUrl);
  if (!url) return '<span class="markup-error">[sticker invalide]</span>';
  if (!allowExternalEmbeds) return safeExternalLink(url);
  return `<img class="post-sticker-image" src="${escapeHtml(url.toString())}" alt="Sticker" loading="lazy">`;
}

function linkedMediaMarkup(rawUrl, { allowExternalEmbeds = true } = {}) {
  const url = safeUrl(rawUrl);
  if (!url) return escapeHtml(rawUrl);
  if (!allowExternalEmbeds) return safeExternalLink(url);
  const noelshackImage = normalizeNoelshackImage(url.toString());
  if (noelshackImage) return stickerMarkup(noelshackImage.toString(), { allowExternalEmbeds });
  const youtubeId = youtubeVideoId(url);
  if (youtubeId) {
    return `<iframe class="post-media-embed post-youtube-embed" src="https://www.youtube-nocookie.com/embed/${youtubeId}" title="Vidéo YouTube" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
  }
  const tiktokId = tiktokVideoId(url);
  if (tiktokId) {
    return `<iframe class="post-media-embed post-tiktok-embed" src="https://www.tiktok.com/player/v1/${tiktokId}?autoplay=0&amp;description=1" title="Vidéo TikTok" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen" allowfullscreen></iframe>`;
  }
  const vocarooId = vocarooRecordingId(url);
  if (vocarooId) return vocarooMarkup(vocarooId);
  if (directImgurImage(url)) return imageMarkup(url.toString(), { allowExternalEmbeds });
  return safeExternalLink(url);
}

function protectMedia(raw, options = {}) {
  const replacements = [];
  const save = (html) => {
    const token = `AVEBAREMBEDTOKEN${replacements.length}ENDTOKEN`;
    replacements.push({ token, html });
    return token;
  };
  let output = String(raw || '').replace(/\[sticker\]([\s\S]*?)\[\/sticker\]/gi, (_, url) => save(stickerMarkup(url, options)));
  output = output.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_, url) => save(imageMarkup(url, options)));
  output = output.replace(/https?:\/\/[^\s<>\[\]]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.!?;:'"]+$/)?.[0] || '';
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${save(linkedMediaMarkup(url, options))}${trailing}`;
  });
  return { output, replacements };
}

// Rendu sécurisé des quelques balises proposées dans l'éditeur de messages.
function formatPostBody(raw, options = {}) {
  const protectedMedia = protectMedia(String(raw || '').slice(0, 20000), options);
  let output = escapeHtml(protectedMedia.output);
  const tags = [
    ['b', 'strong'],
    ['i', 'em'],
    ['s', 's'],
    ['u', 'u'],
  ];
  for (const [source, target] of tags) {
    const expression = new RegExp(`\\[${source}\\]([\\s\\S]*?)\\[\\/${source}\\]`, 'gi');
    output = output.replace(expression, `<${target}>$1</${target}>`);
  }
  output = output.replace(
    /\[color=(#[0-9a-f]{3,8})\]([\s\S]*?)\[\/color\]/gi,
    (_, color, text) => `<span style="color:${color}">${text}</span>`
  );
  output = output.replace(/&lt;spoiler&gt;([\s\S]*?)&lt;\/spoiler&gt;/gi, '<details class="post-spoiler"><summary>Afficher le spoiler</summary>$1</details>');
  output = output.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<details class="post-spoiler"><summary>Afficher le spoiler</summary>$1</details>');
  output = output.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>');
  output = output.replace(/\r?\n/g, '<br>');
  protectedMedia.replacements.forEach(({ token, html }) => {
    output = output.replaceAll(token, html);
  });
  return sanitizeHtml(output, {
    allowedTags: ['strong', 'em', 's', 'u', 'span', 'div', 'img', 'details', 'summary', 'blockquote', 'br', 'a', 'iframe'],
    allowedAttributes: {
      span: ['class', 'style'],
      div: ['class', 'style'],
      img: ['class', 'src', 'alt', 'loading'],
      details: ['class'],
      a: ['class', 'href', 'target', 'rel'],
      iframe: ['class', 'style', 'src', 'title', 'loading', 'referrerpolicy', 'sandbox', 'allow', 'allowfullscreen'],
    },
    allowedStyles: {
      span: { color: [/^#[0-9a-f]{3,8}$/i] },
      div: {
        left: [/^0$/],
        width: [/^100%$/],
        height: [/^60px$/],
        position: [/^relative$/],
      },
      iframe: {
        top: [/^0$/],
        left: [/^0$/],
        width: [/^100%$/],
        height: [/^100%$/],
        position: [/^absolute$/],
        border: [/^0$/],
      },
    },
    allowedSchemes: ['http', 'https'],
    allowedIframeHostnames: ['www.youtube-nocookie.com', 'www.tiktok.com', 'vocaroo.com'],
  });
}

function formatPrivateMessageBody(raw) {
  // Les ressources tierces sont laissées sous forme de liens dans les MP :
  // cela empêche un expéditeur d'utiliser une image/vidéo distante comme pixel
  // de pistage. Les images envoyées sur Alchimie (/media/...) restent intégrées.
  return formatPostBody(raw, { allowExternalEmbeds: false });
}

module.exports = { cleanBody, formatPostBody, formatPrivateMessageBody };
