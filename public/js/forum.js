(() => {
  const dialog = document.getElementById('sanction-dialog');
  if (dialog) {
    const userId = document.getElementById('sanction-user-id');
    const type = document.getElementById('sanction-type');
    const title = document.getElementById('sanction-title');
    const duration = document.getElementById('sanction-duration');
    const submit = document.getElementById('sanction-submit');
    const eradicationWarning = document.getElementById('eradication-warning');
    const usernameField = document.getElementById('sanction-username-field');
    const usernameInput = document.getElementById('sanction-username');
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-sanction-dialog]');
      if (!button) return;
        const isExclusion = button.dataset.type === 'exclusion';
        const isEradication = button.dataset.type === 'eradication';
        const hasTarget = Boolean(button.dataset.userId);
        userId.value = hasTarget ? button.dataset.userId : '';
        if (usernameField) usernameField.hidden = hasTarget;
        if (usernameInput) {
          usernameInput.required = !hasTarget;
          usernameInput.value = hasTarget ? '' : (button.dataset.username || '');
        }
        type.value = isEradication ? 'eradication' : (isExclusion ? 'exclusion' : 'ban');
        title.textContent = hasTarget
          ? `${isEradication ? 'Éradiquer' : (isExclusion ? 'Exclure' : 'Bannir')} ${button.dataset.username}`
          : 'Sanctionner un membre';
        duration.hidden = !isExclusion;
        if (eradicationWarning) eradicationWarning.hidden = !isEradication;
        submit.textContent = isEradication ? "Confirmer l'éradication" : (isExclusion ? "Confirmer l'exclusion" : 'Confirmer le bannissement');
        dialog.showModal();
    });
    dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }

  const pollToggle = document.querySelector('[data-poll-toggle]');
  const pollFields = document.getElementById('poll-fields');
  if (pollToggle && pollFields) pollToggle.addEventListener('click', () => { pollFields.hidden = !pollFields.hidden; });

  const replyForm = document.querySelector('.reply-form');
  if (!replyForm) return;
  const targetInput = replyForm.querySelector('[data-reply-target-input]');
  const targetBar = replyForm.querySelector('[data-reply-target]');
  const targetName = replyForm.querySelector('[data-reply-target-name]');
  const targetNumber = replyForm.querySelector('[data-reply-target-number]');
  const textarea = replyForm.querySelector('[data-reply-textarea]');
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reply-post]');
    if (!button) return;
      targetInput.value = button.dataset.postId;
      targetName.textContent = button.dataset.username;
      targetNumber.textContent = `#${button.dataset.postId}`;
      targetBar.hidden = false;
      replyForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => textarea.focus(), 350);
  });
  targetBar.querySelector('[data-reply-cancel]').addEventListener('click', () => {
    targetInput.value = '';
    targetBar.hidden = true;
    textarea.focus();
  });
})();
