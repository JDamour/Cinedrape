/**
 * Cinedrape — Official Website Interactive Engine
 * Controls theme playground, calm mode simulator, tabs, modal lightbox & FAQs.
 */

// 1. Theme Playground Configurations
const THEMES = {
  cinema: {
    name: "Cinema",
    bg: "#0b0b0f",
    surface: "#16161d",
    text: "#f2f2f5",
    muted: "#a3a3b2",
    accent: "#e8b04a",
    border: "#353642",
    radius: "10px",
    font: "system-ui, sans-serif"
  },
  oled: {
    name: "True Black",
    bg: "#000000",
    surface: "#0d0d0d",
    text: "#ffffff",
    muted: "#9aa5b5",
    accent: "#38bdf8",
    border: "#262933",
    radius: "6px",
    font: "system-ui, sans-serif"
  },
  terminal: {
    name: "Retro Terminal",
    bg: "#050905",
    surface: "#0d140d",
    text: "#2df551",
    muted: "#20a038",
    accent: "#00ff41",
    border: "#1f3a23",
    radius: "2px",
    font: "ui-monospace, Consolas, monospace"
  },
  frost: {
    name: "Frost",
    bg: "#0f172a",
    surface: "#1e293b",
    text: "#f1f5f9",
    muted: "#94a3b8",
    accent: "#22d3ee",
    border: "#334155",
    radius: "8px",
    font: "system-ui, sans-serif"
  },
  paper: {
    name: "Paper Study",
    bg: "#f6f3eb",
    surface: "#ffffff",
    text: "#1c1b18",
    muted: "#59564f",
    accent: "#8c3822",
    border: "#ded9cc",
    radius: "4px",
    font: "Georgia, Cambria, serif"
  },
  matcha: {
    name: "Matcha",
    bg: "#0e1511",
    surface: "#17231c",
    text: "#e8f2eb",
    muted: "#8ca895",
    accent: "#4ade80",
    border: "#283b30",
    radius: "10px",
    font: "system-ui, sans-serif"
  },
  arcade: {
    name: "Arcade",
    bg: "#07070d",
    surface: "#12121f",
    text: "#f4f4ff",
    muted: "#a6a6cf",
    accent: "#ff3df2",
    border: "#36365a",
    radius: "4px",
    font: "system-ui, sans-serif"
  },
  mocha: {
    name: "Mocha",
    bg: "#15100e",
    surface: "#241c19",
    text: "#f7eee9",
    muted: "#b39e95",
    accent: "#e0a96d",
    border: "#42342e",
    radius: "10px",
    font: "system-ui, sans-serif"
  }
};

document.addEventListener('DOMContentLoaded', () => {
  // Theme Switching
  const mockViewport = document.getElementById('mockViewport');
  const themePills = document.querySelectorAll('.theme-pill');
  const calmToggle = document.getElementById('calmToggle');
  const layoutToggle = document.getElementById('layoutToggle');
  const mockHero = document.getElementById('mockHero');

  function applyTheme(themeKey) {
    const t = THEMES[themeKey] || THEMES.cinema;
    if (!mockViewport) return;

    mockViewport.style.setProperty('--mock-bg', t.bg);
    mockViewport.style.setProperty('--mock-surface', t.surface);
    mockViewport.style.setProperty('--mock-text', t.text);
    mockViewport.style.setProperty('--mock-muted', t.muted);
    mockViewport.style.setProperty('--mock-accent', t.accent);
    mockViewport.style.setProperty('--mock-border', t.border);
    mockViewport.style.setProperty('--mock-radius', t.radius);
    mockViewport.style.fontFamily = t.font;

    themePills.forEach(pill => {
      if (pill.dataset.theme === themeKey) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  themePills.forEach(pill => {
    pill.addEventListener('click', () => {
      applyTheme(pill.dataset.theme);
    });
  });

  // Calm Mode Toggle in Mock
  if (calmToggle && mockViewport) {
    calmToggle.addEventListener('click', () => {
      const isActive = mockViewport.classList.toggle('calm-mode-active');
      calmToggle.classList.toggle('active', isActive);
      const textSpan = calmToggle.querySelector('.toggle-text');
      if (textSpan) {
        textSpan.textContent = isActive ? "Calm Mode: ON" : "Calm Mode: OFF";
      }
    });
  }

  // Layout Toggle in Mock (Hero vs Grid)
  if (layoutToggle && mockHero) {
    layoutToggle.addEventListener('click', () => {
      const isHidden = mockHero.style.display === 'none';
      mockHero.style.display = isHidden ? 'flex' : 'none';
      layoutToggle.classList.toggle('active', !isHidden);
      const textSpan = layoutToggle.querySelector('.toggle-text');
      if (textSpan) {
        textSpan.textContent = isHidden ? "Layout: Hero Rows" : "Layout: Standard Grid";
      }
    });
  }

  // Installation Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.dataset.target;
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // Copy Code Snippets
  const copyBtns = document.querySelectorAll('.copy-btn');
  copyBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const codeTarget = btn.dataset.code;
      if (!codeTarget) return;

      try {
        await navigator.clipboard.writeText(codeTarget);
        const originalText = btn.textContent;
        btn.textContent = "Copied!";
        btn.style.color = "#10b981";
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.color = "";
        }, 2000);
      } catch (err) {
        console.error("Clipboard copy failed:", err);
      }
    });
  });

  // FAQ Accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (questionBtn) {
      questionBtn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        // Close others
        faqItems.forEach(i => i.classList.remove('open'));
        if (!isOpen) {
          item.classList.add('open');
        }
      });
    }
  });

  // Screenshot Lightbox Modal
  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalImage = document.getElementById('modalImage');
  const modalCaption = document.getElementById('modalCaption');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const galleryItems = document.querySelectorAll('.gallery-item');

  function openModal(src, caption) {
    if (!modalBackdrop || !modalImage) return;
    modalImage.src = src;
    if (modalCaption) modalCaption.textContent = caption || "";
    modalBackdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modalBackdrop) return;
    modalBackdrop.classList.remove('open');
    document.body.style.overflow = '';
  }

  galleryItems.forEach(item => {
    item.addEventListener('click', () => {
      const img = item.querySelector('img');
      const title = item.querySelector('.gallery-title')?.textContent;
      const desc = item.querySelector('.gallery-desc')?.textContent;
      const caption = title ? `${title} — ${desc || ''}` : '';
      if (img) openModal(img.src, caption);
    });
  });

  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) closeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalBackdrop?.classList.contains('open')) {
      closeModal();
    }
  });

  // Mobile Navigation Menu Toggle
  const mobileToggle = document.getElementById('mobileToggle');
  const navLinks = document.getElementById('navLinks');

  if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });

    // Close menu when clicking a link
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('open');
      });
    });
  }

  // Contextual #welcome / #bye banner for extension install & uninstall routes
  const hashBanner = document.getElementById('hashBanner');
  function renderHashBanner() {
    if (!hashBanner) return;
    const hash = window.location.hash.toLowerCase();
    if (hash === '#welcome') {
      hashBanner.style.display = 'block';
      hashBanner.innerHTML = `
        <div style="background: rgba(232,176,74,0.12); border: 1px solid rgba(232,176,74,0.4); border-radius: 12px; padding: 1.25rem 1.5rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;">
          <div>
            <strong style="color: #e8b04a; font-size: 1.05rem;">🎉 Welcome to Cinedrape v0.1.1!</strong>
            <p style="margin: 0.35rem 0 0; opacity: 0.9; font-size: 0.95rem;">Cinedrape is now installed. Open any <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer" style="color: #e8b04a; text-decoration: underline;">YouTube tab</a> and click the Cinedrape icon in your browser toolbar to pick from all 16 free themes and Calm Mode filters.</p>
          </div>
          <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Open YouTube →</a>
        </div>
      `;
    } else if (hash === '#bye') {
      hashBanner.style.display = 'block';
      hashBanner.innerHTML = `
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 1.25rem 1.5rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;">
          <div>
            <strong style="font-size: 1.05rem;">Sorry to see you go!</strong>
            <p style="margin: 0.35rem 0 0; opacity: 0.85; font-size: 0.95rem;">Did something not work as expected on YouTube, or would you like to request a feature? Let us know on GitHub Issues so we can improve Cinedrape.</p>
          </div>
          <a href="https://github.com/JDamour/Cinedrape/issues/new" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Report an Issue</a>
        </div>
      `;
    } else {
      hashBanner.style.display = 'none';
      hashBanner.innerHTML = '';
    }
  }
  renderHashBanner();
  window.addEventListener('hashchange', renderHashBanner);

  // Initialize Default Cinema Theme
  applyTheme('cinema');
});
