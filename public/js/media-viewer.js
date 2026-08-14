(() => {
  const viewableSelector = '.post-inline-image, .post-sticker-image, .profile-bio-image';
  let viewer;
  let viewerImage;
  let viewerCaption;
  let closeButton;
  let previousFocus;

  function enhanceImage(image) {
    if (!(image instanceof HTMLImageElement) || image.dataset.mediaViewerReady) return;
    image.dataset.mediaViewerReady = 'true';
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `${image.alt || 'Image'} - agrandir`);
    image.title = 'Cliquer pour agrandir';
  }

  function enhanceImages(root = document) {
    if (root instanceof Element && root.matches(viewableSelector)) enhanceImage(root);
    root.querySelectorAll?.(viewableSelector).forEach(enhanceImage);
  }

  function ensureViewer() {
    if (viewer) return;
    viewer = document.createElement('section');
    viewer.className = 'media-lightbox';
    viewer.hidden = true;
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Visionneuse d’image');
    viewer.innerHTML = `
      <button type="button" class="media-lightbox-close" aria-label="Fermer la visionneuse">×</button>
      <figure class="media-lightbox-figure">
        <img class="media-lightbox-image" alt="">
        <figcaption class="media-lightbox-caption"></figcaption>
      </figure>`;
    viewerImage = viewer.querySelector('.media-lightbox-image');
    viewerCaption = viewer.querySelector('.media-lightbox-caption');
    closeButton = viewer.querySelector('.media-lightbox-close');
    closeButton.addEventListener('click', closeViewer);
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer || event.target.classList.contains('media-lightbox-figure')) closeViewer();
    });
    document.body.appendChild(viewer);
  }

  function openViewer(sourceImage) {
    ensureViewer();
    previousFocus = sourceImage;
    viewerImage.src = sourceImage.currentSrc || sourceImage.src;
    viewerImage.alt = sourceImage.alt || 'Image agrandie';
    viewerImage.classList.toggle('media-lightbox-sticker', sourceImage.classList.contains('post-sticker-image'));
    viewerCaption.textContent = sourceImage.alt || '';
    viewerCaption.hidden = !viewerCaption.textContent;
    viewer.hidden = false;
    document.documentElement.classList.add('has-open-media-lightbox');
    closeButton.focus();
  }

  function closeViewer() {
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
    viewerImage.removeAttribute('src');
    document.documentElement.classList.remove('has-open-media-lightbox');
    previousFocus?.focus();
  }

  document.addEventListener('click', (event) => {
    const image = event.target.closest?.(viewableSelector);
    if (image) openViewer(image);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeViewer();
      return;
    }
    if (!['Enter', ' '].includes(event.key)) return;
    const image = event.target.closest?.(viewableSelector);
    if (!image) return;
    event.preventDefault();
    openViewer(image);
  });

  enhanceImages();
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
      if (node instanceof Element) enhanceImages(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
})();
