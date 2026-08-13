// The header's join/leave toast — a one-line message that fades in place
// instead of being removed, so it never shifts the header's flex layout.
// See ../../design/onzvoip_ui_mockup_spec.md §2.

let toastEl = null;
let toastTextEl = null;
let toastTimer = null;

export function setupToast(el, textEl) {
  toastEl = el;
  toastTextEl = textEl;
}

export function showToast(msg) {
  if (!toastEl) return;
  if (toastTextEl) toastTextEl.textContent = msg;
  toastEl.className = 'onz-toast show';
  toastEl.style.opacity = '.95';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3200);
}
