const KEY = 'shelfie-theme';
const root = document.documentElement;
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function effective() {
  return stored() || (media.matches ? 'dark' : 'light');
}

function apply() {
  const choice = stored();
  if (choice) root.dataset.theme = choice;
  else delete root.dataset.theme;
  const button = document.getElementById('btn-theme');
  if (!button) return;
  const next = effective() === 'dark' ? 'light' : 'dark';
  button.dataset.mode = effective();
  button.setAttribute('aria-label', `Switch to ${next} mode`);
  button.title = `Switch to ${next} mode`;
}

apply();

document.addEventListener('DOMContentLoaded', () => {
  apply();
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    try {
      localStorage.setItem(KEY, effective() === 'dark' ? 'light' : 'dark');
    } catch {
      root.dataset.theme = effective() === 'dark' ? 'light' : 'dark';
    }
    apply();
  });
});

media.addEventListener('change', apply);
