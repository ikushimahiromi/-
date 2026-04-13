/* ============================================================
   鍼灸整体院-HIRO- Main JavaScript
   ============================================================ */

(function () {
  'use strict';

  // ── ハンバーガーメニュー ──────────────────────────
  const hamburger = document.getElementById('hamburger');
  const headerNav = document.getElementById('headerNav');

  if (hamburger && headerNav) {
    hamburger.addEventListener('click', () => {
      const isOpen = hamburger.classList.toggle('active');
      headerNav.classList.toggle('open', isOpen);
      hamburger.setAttribute('aria-label', isOpen ? 'メニューを閉じる' : 'メニューを開く');
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    // ナビリンクをクリックしたら閉じる
    headerNav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('active');
        headerNav.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }

  // ── スクロール時ヘッダー影 ──────────────────────
  const header = document.getElementById('header');

  function onScroll() {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 40);

    // トップへ戻るボタン
    const backToTop = document.getElementById('backToTop');
    if (backToTop) {
      backToTop.classList.toggle('visible', window.scrollY > 400);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  // ── トップへ戻る ────────────────────────────────
  const backToTop = document.getElementById('backToTop');
  if (backToTop) {
    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── FAQ アコーディオン ────────────────────────────
  document.querySelectorAll('.faq__question').forEach(btn => {
    btn.addEventListener('click', () => {
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      const answer = btn.nextElementSibling;

      // 他を閉じる
      document.querySelectorAll('.faq__question').forEach(other => {
        if (other !== btn) {
          other.setAttribute('aria-expanded', 'false');
          const otherAnswer = other.nextElementSibling;
          if (otherAnswer) otherAnswer.classList.remove('open');
        }
      });

      btn.setAttribute('aria-expanded', String(!isExpanded));
      if (answer) answer.classList.toggle('open', !isExpanded);
    });
  });

  // ── Intersection Observer でフェードイン ────────
  const fadeEls = document.querySelectorAll(
    '.symptoms__item, .reasons__item, .menu__card, .staff__card, .voice__card, .about__inner, .access__inner, .faq__item'
  );

  if ('IntersectionObserver' in window) {
    fadeEls.forEach(el => el.classList.add('fade-in'));

    const io = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    fadeEls.forEach(el => io.observe(el));
  }

  // ── スムーズスクロール（ヘッダー高さ考慮）───────
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', e => {
      const hash = anchor.getAttribute('href');
      if (!hash || hash === '#') return;
      const target = document.querySelector(hash);
      if (!target) return;
      e.preventDefault();
      const headerH = header ? header.offsetHeight : 72;
      const top = target.getBoundingClientRect().top + window.scrollY - headerH - 8;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });

  // ── フォームバリデーション ─────────────────────
  const contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.addEventListener('submit', e => {
      e.preventDefault();
      let valid = true;
      const errors = [];

      const name = contactForm.querySelector('#name');
      if (name && !name.value.trim()) {
        errors.push('お名前を入力してください。');
        valid = false;
      }

      const phone = contactForm.querySelector('#phone');
      if (phone && !phone.value.trim()) {
        errors.push('電話番号を入力してください。');
        valid = false;
      }

      const privacy = contactForm.querySelector('#privacy');
      if (privacy && !privacy.checked) {
        errors.push('プライバシーポリシーへの同意が必要です。');
        valid = false;
      }

      if (!valid) {
        alert(errors.join('\n'));
        return;
      }

      // 送信成功メッセージ（実際はバックエンドへ送信）
      const submitBtn = contactForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      setTimeout(() => {
        contactForm.innerHTML = `
          <div style="text-align:center;padding:48px 20px;">
            <div style="font-size:3rem;margin-bottom:16px;">✅</div>
            <h3 style="font-size:1.2rem;margin-bottom:12px;color:#2e7d4f;">送信が完了しました</h3>
            <p style="color:#666;font-size:0.9rem;line-height:1.8;">
              お問い合わせありがとうございます。<br>
              2営業日以内にご連絡いたします。
            </p>
          </div>
        `;
      }, 400);
    });
  }

})();
