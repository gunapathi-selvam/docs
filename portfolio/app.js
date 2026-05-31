/* ══════════════════════════════════════════
   FORGE — app.js
   WebGL + GSAP + Interactions
══════════════════════════════════════════ */

/* ─── GSAP setup ─── */
gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

/* ─── Utility ─── */
const qs = (s, ctx = document) => ctx.querySelector(s);
const qsa = (s, ctx = document) => [...ctx.querySelectorAll(s)];
const isMobile = () => window.innerWidth <= 768;
const lerp = (a, b, t) => a + (b - a) * t;

/* ════════════════════════════════════════
   1. THREE.JS BACKGROUND
════════════════════════════════════════ */
(function initWebGL() {
  const canvas = qs('#bg-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x080808, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 0, 30);

  /* Fog */
  scene.fog = new THREE.FogExp2(0x080808, 0.018);

  /* ── Particle System ── */
  const particleCount = isMobile() ? 800 : 2000;
  const positions = new Float32Array(particleCount * 3);
  const colors    = new Float32Array(particleCount * 3);
  const sizes     = new Float32Array(particleCount);
  const speeds    = new Float32Array(particleCount);

  const baseColors = [
    new THREE.Color('#ff6b35'),
    new THREE.Color('#c8963e'),
    new THREE.Color('#ff8c5a'),
    new THREE.Color('#552211'),
    new THREE.Color('#332233'),
  ];

  for (let i = 0; i < particleCount; i++) {
    const r = 20 + Math.random() * 30;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const c = baseColors[Math.floor(Math.random() * baseColors.length)];
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;

    sizes[i]  = Math.random() * 2.5 + 0.5;
    speeds[i] = Math.random() * 0.5 + 0.1;
  }

  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
  pGeo.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));

  const pMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vOpacity;
      uniform float uTime;
      void main() {
        vColor = color;
        vec3 pos = position;
        float wave = sin(pos.x * 0.1 + uTime * 0.4) * 0.5
                   + cos(pos.y * 0.08 + uTime * 0.3) * 0.5;
        pos.z += wave;
        vOpacity = 0.4 + 0.6 * abs(sin(uTime * 0.5 + pos.x * 0.05));
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = size * (200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vOpacity;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.1, d);
        gl_FragColor = vec4(vColor, a * vOpacity * 0.7);
      }
    `,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  /* ── Metallic Torus Grid ── */
  const torusGroup = new THREE.Group();
  scene.add(torusGroup);

  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.95,
    roughness: 0.15,
    envMapIntensity: 1,
  });

  const torusConfigs = [
    { r: 8, tube: 0.06, x: -5,  y: 3,  z: -8,  rx: 0.8, ry: 0.4 },
    { r: 6, tube: 0.05, x: 6,   y: -2, z: -5,  rx: 1.2, ry: 0.8 },
    { r: 10,tube: 0.04, x: 0,   y: 0,  z: -15, rx: 0.3, ry: 1.1 },
    { r: 5, tube: 0.07, x: -8,  y: -4, z: -6,  rx: 2.0, ry: 0.2 },
  ];

  torusConfigs.forEach(cfg => {
    const geo  = new THREE.TorusGeometry(cfg.r, cfg.tube, 12, 80);
    const mesh = new THREE.Mesh(geo, metalMat);
    mesh.position.set(cfg.x, cfg.y, cfg.z);
    mesh.rotation.set(cfg.rx, cfg.ry, 0);
    mesh.userData = { rx: cfg.rx, ry: cfg.ry };
    torusGroup.add(mesh);
  });

  /* ── Wireframe Icosahedron ── */
  const icoGeo  = new THREE.IcosahedronGeometry(4, 1);
  const icoMat  = new THREE.MeshBasicMaterial({ color: 0xff6b35, wireframe: true, transparent: true, opacity: 0.08 });
  const icosahedron = new THREE.Mesh(icoGeo, icoMat);
  icosahedron.position.set(12, -2, -10);
  scene.add(icosahedron);

  /* ── Grid Floor ── */
  const gridHelper = new THREE.GridHelper(80, 40, 0xff6b35, 0x1a1a1a);
  gridHelper.position.y = -15;
  gridHelper.material.opacity = 0.12;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  /* ── Accent Lines ── */
  const lineMat = new THREE.LineBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.15 });
  for (let i = 0; i < 12; i++) {
    const pts = [];
    const x = (Math.random() - 0.5) * 60;
    const y = (Math.random() - 0.5) * 40;
    pts.push(new THREE.Vector3(x, y, -30 + Math.random() * 10));
    pts.push(new THREE.Vector3(x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 10, -20));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    scene.add(new THREE.Line(lineGeo, lineMat));
  }

  /* ── Lights ── */
  scene.add(new THREE.AmbientLight(0xffffff, 0.1));
  const pointLight1 = new THREE.PointLight(0xff6b35, 1.5, 50);
  pointLight1.position.set(10, 10, 10);
  scene.add(pointLight1);
  const pointLight2 = new THREE.PointLight(0xc8963e, 0.8, 40);
  pointLight2.position.set(-10, -5, 5);
  scene.add(pointLight2);

  /* ── Mouse parallax ── */
  let mouseX = 0, mouseY = 0;
  let targetX = 0, targetY = 0;
  window.addEventListener('mousemove', e => {
    mouseX = (e.clientX / window.innerWidth  - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  /* ── Scroll camera float ── */
  let scrollY = 0;
  window.addEventListener('scroll', () => { scrollY = window.scrollY; });

  /* ── Resize ── */
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ── Render loop ── */
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    /* Lerp mouse */
    targetX = lerp(targetX, mouseX, 0.04);
    targetY = lerp(targetY, mouseY, 0.04);

    /* Camera float */
    camera.position.x = lerp(camera.position.x, targetX * 3, 0.03);
    camera.position.y = lerp(camera.position.y, -targetY * 2 - scrollY * 0.004, 0.03);
    camera.lookAt(0, -scrollY * 0.003, 0);

    /* Particles */
    pMat.uniforms.uTime.value = t;
    particles.rotation.y = t * 0.018;
    particles.rotation.x = Math.sin(t * 0.1) * 0.08;

    /* Tori */
    torusGroup.children.forEach((mesh, i) => {
      mesh.rotation.x = mesh.userData.rx + t * (0.15 + i * 0.04);
      mesh.rotation.y = mesh.userData.ry + t * (0.1  + i * 0.03);
    });

    /* Icosahedron */
    icosahedron.rotation.x = t * 0.12;
    icosahedron.rotation.y = t * 0.18;
    icosahedron.position.y = -2 + Math.sin(t * 0.5) * 1.5;

    /* Grid drift */
    gridHelper.position.z = (scrollY * 0.02) % 2;

    /* Lights pulse */
    pointLight1.intensity = 1.2 + Math.sin(t * 1.5) * 0.4;

    renderer.render(scene, camera);
  }
  animate();
})();


/* ════════════════════════════════════════
   2. CUSTOM CURSOR
════════════════════════════════════════ */
(function initCursor() {
  if (isMobile()) return;
  const outer = qs('#cursor-outer');
  const inner = qs('#cursor-inner');
  if (!outer || !inner) return;

  let ox = -100, oy = -100, ix = -100, iy = -100;
  let tx = -100, ty = -100;

  document.addEventListener('mousemove', e => { tx = e.clientX; ty = e.clientY; });
  document.addEventListener('mousedown', () => outer.classList.add('click'));
  document.addEventListener('mouseup',   () => outer.classList.remove('click'));

  const hoverEls = 'a, button, [data-project], .service-card, select, input, textarea';
  document.addEventListener('mouseover', e => {
    if (e.target.closest(hoverEls)) outer.classList.add('hover');
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest(hoverEls)) outer.classList.remove('hover');
  });

  function loop() {
    ix = lerp(ix, tx, 0.25);
    iy = lerp(iy, ty, 0.25);
    ox = lerp(ox, tx, 0.1);
    oy = lerp(oy, ty, 0.1);
    inner.style.left = `${ix}px`;
    inner.style.top  = `${iy}px`;
    outer.style.left = `${ox}px`;
    outer.style.top  = `${oy}px`;
    requestAnimationFrame(loop);
  }
  loop();
})();


/* ════════════════════════════════════════
   3. NAVIGATION
════════════════════════════════════════ */
(function initNav() {
  const nav    = qs('#nav');
  const burger = qs('#nav-burger');
  const menu   = qs('#mobile-menu');

  /* Scroll state */
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Burger */
  if (burger && menu) {
    burger.addEventListener('click', () => {
      const open = burger.classList.toggle('open');
      menu.classList.toggle('open', open);
      document.body.classList.toggle('menu-open', open);
    });
    qsa('[data-mobile-nav]').forEach(a => {
      a.addEventListener('click', () => {
        burger.classList.remove('open');
        menu.classList.remove('open');
        document.body.classList.remove('menu-open');
      });
    });
  }

  /* Smooth scroll for nav links */
  qsa('[data-nav], [data-mobile-nav]').forEach(a => {
    a.addEventListener('click', e => {
      const href = a.getAttribute('href');
      if (href && href.startsWith('#')) {
        e.preventDefault();
        const target = qs(href);
        if (target) gsap.to(window, { scrollTo: { y: target, offsetY: 72 }, duration: 1.2, ease: 'power3.inOut' });
      }
    });
  });
})();


/* ════════════════════════════════════════
   4. HERO ENTRANCE
════════════════════════════════════════ */
(function heroEntrance() {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 });

  /* Label */
  const label = qs('.hero-label');
  if (label) {
    tl.to(label, { duration: 0 })
      .call(() => label.classList.add('in'), [], 0.2);
  }

  /* Lines */
  qsa('[data-hero-line]').forEach((el, i) => {
    tl.call(() => el.classList.add('in'), [], 0.4 + i * 0.12);
  });

  /* Sub */
  const sub = qs('.hero-sub');
  if (sub) tl.call(() => sub.classList.add('in'), [], 0.72);

  /* Actions */
  const actions = qs('.hero-actions');
  if (actions) tl.call(() => actions.classList.add('in'), [], 0.9);

  /* Stats */
  const stats = qs('.hero-stats');
  if (stats) tl.call(() => stats.classList.add('in'), [], 1.1);

  /* Counter animation */
  function countUp(el) {
    const target = parseInt(el.dataset.count, 10);
    let current = 0;
    const step = target / 50;
    const timer = setInterval(() => {
      current = Math.min(current + step, target);
      el.textContent = Math.floor(current);
      if (current >= target) clearInterval(timer);
    }, 28);
  }

  /* Fire counters once stats fade in */
  setTimeout(() => {
    qsa('.stat-num').forEach(el => countUp(el));
  }, 1200);
})();


/* ════════════════════════════════════════
   5. SCROLL REVEAL
════════════════════════════════════════ */
(function initReveal() {
  qsa('[data-reveal]').forEach((el, i) => {
    ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      onEnter: () => {
        gsap.to(el, {
          opacity: 1,
          y: 0,
          duration: 0.9,
          delay: (i % 4) * 0.07,
          ease: 'power3.out',
          onStart: () => el.classList.add('revealed'),
        });
      },
    });
  });
})();


/* ════════════════════════════════════════
   6. SERVICES — stagger reveal
════════════════════════════════════════ */
(function initServices() {
  qsa('[data-service]').forEach((card, i) => {
    gsap.set(card, { opacity: 0, y: 40 });
    ScrollTrigger.create({
      trigger: card,
      start: 'top 86%',
      onEnter: () => {
        gsap.to(card, { opacity: 1, y: 0, duration: 0.85, delay: i * 0.1, ease: 'power3.out' });
      },
    });
  });
})();


/* ════════════════════════════════════════
   7. PROJECTS — row reveal + image tilt
════════════════════════════════════════ */
(function initProjects() {
  qsa('[data-project]').forEach((row, i) => {
    gsap.set(row, { opacity: 0, x: -30 });
    ScrollTrigger.create({
      trigger: row,
      start: 'top 88%',
      onEnter: () => {
        gsap.to(row, { opacity: 1, x: 0, duration: 0.8, delay: i * 0.09, ease: 'power3.out' });
      },
    });

    const img = row.querySelector('[data-project-img]');
    if (!img) return;
    row.addEventListener('mousemove', e => {
      const rect = row.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width  - 0.5) * 20;
      const py = ((e.clientY - rect.top)  / rect.height - 0.5) * 14;
      gsap.to(img, { rotateY: px, rotateX: -py, duration: 0.4, ease: 'power2.out' });
    });
    row.addEventListener('mouseleave', () => {
      gsap.to(img, { rotateY: 0, rotateX: 0, duration: 0.6, ease: 'power2.out' });
    });
  });
})();


/* ════════════════════════════════════════
   8. ABOUT — forge visual parallax
════════════════════════════════════════ */
(function initAbout() {
  const visual = qs('.about-forge-visual');
  if (!visual) return;
  ScrollTrigger.create({
    trigger: '#about',
    start: 'top bottom',
    end: 'bottom top',
    onUpdate: self => {
      gsap.to(visual, { y: (self.progress - 0.5) * 60, ease: 'none', duration: 0 });
    },
  });
})();


/* ════════════════════════════════════════
   9. PROCESS STEPS
════════════════════════════════════════ */
(function initProcess() {
  qsa('[data-step]').forEach((step, i) => {
    gsap.set(step, { opacity: 0, y: 30 });
    ScrollTrigger.create({
      trigger: step,
      start: 'top 85%',
      onEnter: () => {
        gsap.to(step, { opacity: 1, y: 0, duration: 0.75, delay: i * 0.1, ease: 'power3.out' });
      },
    });
  });
})();


/* ════════════════════════════════════════
   10. TESTIMONIALS CAROUSEL
════════════════════════════════════════ */
(function initTestimonials() {
  const track  = qs('#testimonials-track');
  const dotsWrap = qs('#t-dots');
  const btnPrev = qs('#t-prev');
  const btnNext = qs('#t-next');
  if (!track) return;

  const cards = qsa('.testimonial-card', track);
  let current = 0;
  const total = cards.length;

  /* Build dots */
  cards.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 't-dot' + (i === 0 ? ' active' : '');
    d.addEventListener('click', () => goTo(i));
    dotsWrap.appendChild(d);
  });

  function goTo(n) {
    current = (n + total) % total;
    gsap.to(track, { x: `-${current * 100}%`, duration: 0.65, ease: 'power3.inOut' });
    qsa('.t-dot', dotsWrap).forEach((d, i) => d.classList.toggle('active', i === current));
  }

  btnPrev && btnPrev.addEventListener('click', () => goTo(current - 1));
  btnNext && btnNext.addEventListener('click', () => goTo(current + 1));

  /* Auto-advance */
  let autoTimer = setInterval(() => goTo(current + 1), 5000);
  track.addEventListener('mouseenter', () => clearInterval(autoTimer));
  track.addEventListener('mouseleave', () => { autoTimer = setInterval(() => goTo(current + 1), 5000); });

  /* Swipe */
  let touchStartX = 0;
  track.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const dx = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(dx) > 50) goTo(current + (dx > 0 ? 1 : -1));
  });
})();


/* ════════════════════════════════════════
   11. CONTACT FORM
════════════════════════════════════════ */
(function initForm() {
  const form    = qs('#contact-form');
  const success = qs('#form-success');
  if (!form) return;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('.form-submit');
    const span = btn.querySelector('span');
    const originalText = span.textContent;

    /* Animate button */
    span.textContent = 'SENDING...';
    btn.disabled = true;
    gsap.to(btn, { opacity: 0.7, scale: 0.97, duration: 0.2 });

    setTimeout(() => {
      gsap.to(btn, { opacity: 0, scale: 0.95, duration: 0.3, onComplete: () => { btn.style.display = 'none'; } });
      success.classList.add('show');
      gsap.from(success, { opacity: 0, y: 10, duration: 0.5, ease: 'power3.out' });
      form.reset();
      setTimeout(() => {
        success.classList.remove('show');
        btn.style.display = '';
        btn.disabled = false;
        span.textContent = originalText;
        gsap.to(btn, { opacity: 1, scale: 1, duration: 0.3 });
      }, 4000);
    }, 1400);
  });

  /* Input float labels */
  qsa('.form-group input, .form-group textarea, .form-group select').forEach(el => {
    el.addEventListener('focus', () => {
      gsap.to(el, { borderColor: 'rgba(255,107,53,0.5)', duration: 0.2 });
    });
    el.addEventListener('blur', () => {
      gsap.to(el, { borderColor: 'rgba(255,255,255,0.12)', duration: 0.2 });
    });
  });
})();


/* ════════════════════════════════════════
   12. SCROLL PROGRESS BAR (top accent line)
════════════════════════════════════════ */
(function initScrollProgress() {
  const bar = document.createElement('div');
  bar.style.cssText = `
    position:fixed; top:0; left:0; z-index:999;
    height:2px; width:0%;
    background:linear-gradient(90deg,#ff6b35,#c8963e);
    transition:width 0.1s linear;
    pointer-events:none;
  `;
  document.body.appendChild(bar);
  window.addEventListener('scroll', () => {
    const pct = window.scrollY / (document.body.scrollHeight - window.innerHeight) * 100;
    bar.style.width = pct + '%';
  }, { passive: true });
})();


/* ════════════════════════════════════════
   13. HORIZONTAL MARQUEE PAUSE ON HOVER
════════════════════════════════════════ */
(function initMarquee() {
  const track = qs('.marquee-track');
  if (!track) return;
  track.parentElement.addEventListener('mouseenter', () => { track.style.animationPlayState = 'paused'; });
  track.parentElement.addEventListener('mouseleave', () => { track.style.animationPlayState = 'running'; });
})();


/* ════════════════════════════════════════
   14. HERO SCROLL PARALLAX
════════════════════════════════════════ */
(function heroParallax() {
  const headline = qs('.hero-headline');
  const sub      = qs('.hero-sub');
  const actions  = qs('.hero-actions');

  if (!headline) return;
  ScrollTrigger.create({
    trigger: '#hero',
    start: 'top top',
    end: 'bottom top',
    onUpdate: self => {
      const p = self.progress;
      gsap.set(headline, { y: p * 80, opacity: 1 - p * 1.2 });
      if (sub) gsap.set(sub,     { y: p * 50, opacity: 1 - p * 1.5 });
      if (actions) gsap.set(actions, { y: p * 40, opacity: 1 - p * 1.8 });
    },
  });
})();


/* ════════════════════════════════════════
   15. SECTION TAG LETTER SPLIT ANIMATION
════════════════════════════════════════ */
(function initTagAnimation() {
  qsa('.section-tag[data-reveal]').forEach(el => {
    const text = el.textContent;
    el.textContent = '';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.cssText = `display:inline-block;opacity:0;transform:translateY(8px);transition:opacity 0.3s ${i*0.02}s,transform 0.3s ${i*0.02}s`;
      el.appendChild(s);
    });
    ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      onEnter: () => {
        el.querySelectorAll('span').forEach(s => {
          s.style.opacity = '1';
          s.style.transform = 'translateY(0)';
        });
      },
    });
  });
})();


/* ════════════════════════════════════════
   16. FOOTER AMBIENT GLOW
════════════════════════════════════════ */
(function initFooterGlow() {
  const footer = qs('#footer');
  if (!footer) return;
  const glow = document.createElement('div');
  glow.style.cssText = `
    position:absolute; top:-120px; left:50%; transform:translateX(-50%);
    width:600px; height:240px; border-radius:50%;
    background:radial-gradient(ellipse,rgba(255,107,53,0.06) 0%,transparent 70%);
    pointer-events:none; z-index:0;
  `;
  footer.style.position = 'relative';
  footer.prepend(glow);
  gsap.to(glow, { opacity: 0.5, scale: 1.1, duration: 3, yoyo: true, repeat: -1, ease: 'sine.inOut' });
})();


/* ════════════════════════════════════════
   17. REFRESH SCROLL TRIGGER
════════════════════════════════════════ */
window.addEventListener('load', () => {
  ScrollTrigger.refresh();
});
