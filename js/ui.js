// Small page widgets that know nothing about the PPK2: text helpers, a toast, segmented
// controls, number boxes (digits only, steppers) and "?" hints. Behaviour is attached by
// delegation, so it also covers elements added later.

export const $ = (id) => document.getElementById(id);

/** Write text/markup only when it changed, so periodic refreshes don't churn the DOM. */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

export function setHTML(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function definitionList(rows) {
  return rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

let toastTimer = 0;
export function toast(message, kind = 'info', ms = 4500) {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/** A group of buttons acting as radio buttons (aria-checked); calls onChange with the button's data-value. */
export function segmented(id, value, onChange) {
  const buttons = [...$(id).querySelectorAll('button')];
  const set = (v) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(v))));
  for (const b of buttons) {
    b.addEventListener('click', () => {
      set(b.dataset.value);
      onChange(b.dataset.value);
    });
  }
  set(value);
  return { set };
}

const isNumberBox = (el) => el instanceof HTMLInputElement && el.type === 'number';
const allowsFraction = (el) => el.step === 'any' || !Number.isInteger(Number(el.step || 1));

/**
 * Read a number box: falls back when empty, clamps to its min and max, and rounds when its
 * step is whole. Writes the result back and returns it.
 */
export function readNumber(el, fallback) {
  let v = el.value !== '' && Number.isFinite(Number(el.value)) ? Number(el.value) : fallback;
  if (el.min !== '') v = Math.max(Number(el.min), v);
  if (el.max !== '') v = Math.min(Number(el.max), v);
  if (!allowsFraction(el)) v = Math.round(v);
  el.value = v;
  return v;
}

/** Steppers (.step buttons with data-step beside a number box): a click steps once, holding repeats. */
function step(btn) {
  const input = btn.parentElement.querySelector('input');
  input.value = (Number(input.value) || 0) + Number(btn.dataset.step);
  input.dispatchEvent(new Event('change')); // the box's change handler clamps it
}

/** Attach the delegated behaviour of number boxes, steppers and hints to the page. */
export function initWidgets() {
  // Number boxes take digits only, plus a decimal point where the step allows fractions
  // (no settings are negative, and "e" for exponents isn't wanted).
  document.addEventListener('focusin', (e) => {
    if (isNumberBox(e.target)) e.target.inputMode = allowsFraction(e.target) ? 'decimal' : 'numeric';
  });
  document.addEventListener('keydown', (e) => {
    if (!isNumberBox(e.target) || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/\d/.test(e.key) && !(e.key === '.' && allowsFraction(e.target))) e.preventDefault();
  });
  document.addEventListener('paste', (e) => {
    if (!isNumberBox(e.target)) return;
    const text = e.clipboardData.getData('text').trim();
    if (!(allowsFraction(e.target) ? /^\d*\.?\d*$/ : /^\d*$/).test(text)) e.preventDefault();
  });

  let repeat = 0;
  const stop = () => clearTimeout(repeat);
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest?.('.step');
    if (!btn) return;
    e.preventDefault();
    step(btn);
    repeat = setTimeout(function again() {
      step(btn);
      repeat = setTimeout(again, 75);
    }, 400);
  });
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);
  document.addEventListener('pointerout', (e) => e.target.closest?.('.step') && stop());

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.step');
    if (btn && e.detail === 0) step(btn); // keyboard (Enter or Space)
    // Hints: a click only focuses the "?" (so it doesn't toggle a section it sits in).
    const tip = e.target.closest('.tip-btn');
    if (tip) {
      e.preventDefault();
      tip.focus(); // Safari doesn't focus buttons on click
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest?.('.tip-btn')) e.target.blur();
  });
}
