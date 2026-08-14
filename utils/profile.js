const sanitizeHtml = require('sanitize-html');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function directImgurImage(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!['i.imgur.com', 'imgur.com', 'www.imgur.com'].includes(hostname)) return null;
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function formatBio(raw) {
  const images = [];
  const saveImage = (rawUrl) => {
    const imageUrl = directImgurImage(rawUrl);
    if (!imageUrl) return null;
    const token = `AVEBARBIOIMAGETOKEN${images.length}ENDTOKEN`;
    images.push({ token, imageUrl });
    return token;
  };
  let source = String(raw || '').slice(0, 2000);
  source = source.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_markup, url) => (
    saveImage(url) || '[image Imgur invalide]'
  ));
  source = source.replace(/https:\/\/[^\s<>\[\]]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.!?;:'"]+$/)?.[0] || '';
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    const token = saveImage(url);
    return token ? `${token}${trailing}` : candidate;
  });
  let output = escapeHtml(source);
  const tags = [
    ['g', 'strong'],
    ['i', 'em'],
    ['s', 's'],
    ['u', 'u'],
  ];
  for (const [source, target] of tags) {
    const expression = new RegExp(`&lt;${source}&gt;([\\s\\S]*?)&lt;\\/${source}&gt;`, 'gi');
    output = output.replace(expression, `<${target}>$1</${target}>`);
  }
  output = output.replace(
    /&lt;color(?:=|&gt;\s*)(#[0-9a-f]{3,8})(?:&gt;|\s*\|)([\s\S]*?)&lt;\/color&gt;/gi,
    (_, color, text) => `<span style="color:${color}">${text}</span>`
  );
  output = output.replace(/\r?\n/g, '<br>');
  images.forEach(({ token, imageUrl }) => {
    output = output.replaceAll(
      token,
      `<img class="profile-bio-image" src="${escapeHtml(imageUrl)}" alt="Image Imgur de la biographie" loading="lazy" referrerpolicy="no-referrer">`
    );
  });
  return sanitizeHtml(output, {
    allowedTags: ['strong', 'em', 's', 'u', 'span', 'br', 'img'],
    allowedAttributes: { span: ['style'], img: ['class', 'src', 'alt', 'loading', 'referrerpolicy'] },
    allowedStyles: { span: { color: [/^#[0-9a-f]{3,8}$/i] } },
    allowedSchemes: ['https'],
  });
}

function normalizeHttpsUrl(raw, { imgurOnly = false } = {}) {
  if (!raw) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (imgurOnly && !/(^|\.)imgur\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function youtubeEmbedUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw.trim());
    let id = '';
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
    if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2] || '';
      else if (url.pathname.startsWith('/embed/')) id = url.pathname.split('/')[2] || '';
    }
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) return '';
    return `https://www.youtube-nocookie.com/embed/${id}`;
  } catch {
    return '';
  }
}

module.exports = { formatBio, normalizeHttpsUrl, youtubeEmbedUrl };
