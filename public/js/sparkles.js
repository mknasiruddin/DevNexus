/**
 * DevNexus - Midnight Blue & Deep Purple Particle Engine
 *
 * 1. Dark Mode: Midnight Blue & Deep Purple Aesthetic
 *    - Deep Indigo (#6366F1), Soft Violet (#A78BFA), Deep Purple (#7C3AED), Electric Blue (#60A5FA), Crisp White
 * 2. Light Mode: Pale Purple & Powder Blue Aesthetic
 *    - Lavender (#7C3AED), Powder Blue (#3B82F6), Soft Indigo (#6366F1), Glowing Violet (#A78BFA)
 *
 * Features:
 * - Tiny drifting floating particles with sinusoidal horizontal sway
 * - Delicate 4-point celestial diamond twinkling stars
 * - Soft luminous glowing halos
 * - Ethereal, gentle gradient light streaks with sparkle heads
 * - Real-time theme adaptation via MutationObserver
 * - Zero dependencies, fully non-intrusive (z-index: -1, pointer-events: none)
 * - Accessibility (prefers-reduced-motion) and tab visibility pausing
 */

(function () {
  'use strict';

  // Respect user preference for reduced motion
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  function initSparkles() {
    var canvas = document.getElementById('sparkles-canvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var width = (canvas.width = window.innerWidth);
    var height = (canvas.height = window.innerHeight);

    // =========================================================================
    // Independent Dual-Theme Palettes (Midnight Blue & Deep Purple)
    // =========================================================================

    // Dark Mode Palette: Midnight Blue, Deep Purple, Glowing Violet & Electric Blue
    var DARK_PALETTE = [
      { r: 99,  g: 102, b: 241, name: 'indigo' },       // #6366F1
      { r: 167, g: 139, b: 250, name: 'soft-violet' },  // #A78BFA
      { r: 124, g: 58,  b: 237, name: 'deep-purple' },  // #7C3AED
      { r: 96,  g: 165, b: 250, name: 'electric-blue' },// #60A5FA
      { r: 129, g: 140, b: 248, name: 'periwinkle' },   // #818CF8
      { r: 255, g: 255, b: 255, name: 'pure-white' }    // Crisp white
    ];

    // Light Mode Palette: Pale Purple, Soft Indigo, Powder Blue & Lavender
    var LIGHT_PALETTE = [
      { r: 124, g: 58,  b: 237, name: 'purple' },       // #7C3AED
      { r: 59,  g: 130, b: 246, name: 'powder-blue' },  // #3B82F6
      { r: 99,  g: 102, b: 241, name: 'soft-indigo' },  // #6366F1
      { r: 167, g: 139, b: 250, name: 'glowing-violet' },// #A78BFA
      { r: 129, g: 140, b: 248, name: 'periwinkle' }    // #818CF8
    ];

    function isLightMode() {
      return document.documentElement.getAttribute('data-theme') === 'light';
    }

    function getPalette() {
      return isLightMode() ? LIGHT_PALETTE : DARK_PALETTE;
    }

    // =========================================================================
    // Particle & Celestial Star Generation
    // =========================================================================
    var particles = [];
    var lightStreaks = [];
    var streakTimer = 0;
    var isRunning = true;
    var animFrame = null;

    // Responsive particle count: ~36 to 48 particles for an elegant, non-cluttered atmosphere
    var count = Math.min(48, Math.max(28, Math.floor((width * height) / 28000)));

    function createParticle(initial) {
      var palette = getPalette();
      var colorIdx = Math.floor(Math.random() * palette.length);
      var isStar = Math.random() < 0.28; // ~28% are 4-point diamond stars
      var light = isLightMode();

      return {
        x: Math.random() * width,
        y: initial ? Math.random() * height : height + 15,
        baseX: Math.random() * width,
        isStar: isStar,
        radius: isStar ? (Math.random() * 2.2 + 2.8) : (Math.random() * 1.1 + 0.8),
        halo: Math.random() < 0.35,
        haloSize: Math.random() * 7 + 5,
        vx: (Math.random() - 0.5) * 0.15,
        vy: -(Math.random() * 0.22 + 0.08), // Gentle upward drift
        swaySpeed: Math.random() * 0.012 + 0.006,
        swayPhase: Math.random() * Math.PI * 2,
        swayAmp: Math.random() * 14 + 6,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.008,
        twinkleSpeed: Math.random() * 0.024 + 0.012,
        twinklePhase: Math.random() * Math.PI * 2,
        colorIdx: colorIdx,
        baseAlpha: light ? (Math.random() * 0.3 + 0.38) : (Math.random() * 0.4 + 0.40)
      };
    }

    function refreshPalettes() {
      var light = isLightMode();
      var palette = getPalette();
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.colorIdx = p.colorIdx % palette.length;
        p.baseAlpha = light ? (Math.random() * 0.3 + 0.38) : (Math.random() * 0.4 + 0.40);
      }
      for (var s = 0; s < lightStreaks.length; s++) {
        lightStreaks[s].colorIdx = Math.floor(Math.random() * palette.length);
      }
    }

    // Initialize particle pool
    for (var i = 0; i < count; i++) {
      particles.push(createParticle(true));
    }

    // =========================================================================
    // Delicate Four-Point Diamond Twinkling Star Renderer (✨)
    // Mathematically clean quadratic-bezier star with radiant center glint
    // =========================================================================
    function drawFourPointStar(cx, cy, radius, rot, colorStr, alpha, light) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);

      ctx.beginPath();
      ctx.moveTo(0, -radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.quadraticCurveTo(0, 0, 0, radius);
      ctx.quadraticCurveTo(0, 0, -radius, 0);
      ctx.quadraticCurveTo(0, 0, 0, -radius);
      ctx.closePath();

      ctx.fillStyle = colorStr;
      ctx.fill();

      // Bright celestial core highlight
      var innerR = Math.max(0.6, radius * 0.22);
      ctx.beginPath();
      ctx.arc(0, 0, innerR, 0, Math.PI * 2);
      ctx.fillStyle = light
        ? 'rgba(255, 255, 255, ' + Math.min(0.9, alpha * 1.3) + ')'
        : 'rgba(255, 255, 255, ' + Math.min(1.0, alpha * 1.4) + ')';
      ctx.fill();

      ctx.restore();
    }

    // =========================================================================
    // Gentle Gradient Light Streaks (Animated Aurora Light Trails)
    // =========================================================================
    function spawnLightStreak() {
      if (lightStreaks.length >= 2) return;

      var palette = getPalette();
      var angle = (Math.PI / 6) + (Math.random() - 0.5) * 0.2; // ~25-35 degrees
      var speed = Math.random() * 1.6 + 1.2;

      lightStreaks.push({
        x: Math.random() * (width * 0.7),
        y: Math.random() * (height * 0.5),
        length: Math.random() * 70 + 75,
        speed: speed,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: Math.random() * 120 + 130,
        colorIdx: Math.floor(Math.random() * palette.length),
        glintPhase: 0
      });
    }

    function renderLightStreaks(light) {
      var palette = getPalette();

      for (var s = lightStreaks.length - 1; s >= 0; s--) {
        var streak = lightStreaks[s];
        streak.x += streak.vx;
        streak.y += streak.vy;
        streak.life++;
        streak.glintPhase += 0.08;

        var progress = streak.life / streak.maxLife;
        var fade = Math.sin(progress * Math.PI); // 0 -> 1 -> 0
        var streakAlpha = fade * (light ? 0.40 : 0.52);

        if (streak.life >= streak.maxLife || streak.x > width + 100 || streak.y > height + 100) {
          lightStreaks.splice(s, 1);
          continue;
        }

        var col = palette[streak.colorIdx % palette.length];
        var tailX = streak.x - (streak.vx / streak.speed) * streak.length;
        var tailY = streak.y - (streak.vy / streak.speed) * streak.length;

        var grad = ctx.createLinearGradient(tailX, tailY, streak.x, streak.y);
        grad.addColorStop(0, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ', 0)');
        grad.addColorStop(0.7, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + (streakAlpha * 0.45) + ')');
        grad.addColorStop(1, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + streakAlpha + ')');

        ctx.strokeStyle = grad;
        ctx.lineWidth = light ? 1.5 : 1.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(streak.x, streak.y);
        ctx.stroke();

        var starAlpha = streakAlpha * (0.8 + Math.sin(streak.glintPhase) * 0.2);
        var headColor = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + starAlpha + ')';
        drawFourPointStar(streak.x, streak.y, 4.2, streak.glintPhase, headColor, starAlpha, light);
      }
    }

    // =========================================================================
    // Main Animation Loop
    // =========================================================================
    function render() {
      if (!isRunning) return;

      ctx.clearRect(0, 0, width, height);

      var light = isLightMode();
      var palette = getPalette();

      // Spawn periodic gentle light streaks every ~5-7 seconds (320 frames)
      streakTimer++;
      if (streakTimer > 320) {
        if (Math.random() < 0.6) spawnLightStreak();
        streakTimer = 0;
      }

      // 1. Draw light streaks (trailing behind particles)
      renderLightStreaks(light);

      // 2. Render celestial stars and floating particles
      for (var j = 0; j < particles.length; j++) {
        var p = particles[j];

        p.swayPhase += p.swaySpeed;
        p.x = p.baseX + Math.sin(p.swayPhase) * p.swayAmp;
        p.y += p.vy;
        p.rot += p.rotSpeed;

        if (p.y < -20) {
          p.y = height + 15;
          p.baseX = Math.random() * width;
          p.x = p.baseX;
        }
        if (p.x < -20) { p.baseX = width + 20; p.x = p.baseX; }
        if (p.x > width + 20) { p.baseX = -20; p.x = p.baseX; }

        p.twinklePhase += p.twinkleSpeed;
        var osc = Math.sin(p.twinklePhase);
        var alpha = p.baseAlpha + osc * 0.25;
        if (alpha < 0.08) alpha = 0.08;
        if (alpha > 0.95) alpha = 0.95;

        var col = palette[p.colorIdx % palette.length];
        var colorStr = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + alpha + ')';

        // Soft Glowing Halo
        if (p.halo && alpha > 0.32) {
          var haloR = p.radius + p.haloSize * (0.85 + osc * 0.15);
          var haloGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
          var haloAlpha = alpha * (light ? 0.22 : 0.28);
          haloGrad.addColorStop(0, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + haloAlpha + ')');
          haloGrad.addColorStop(1, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ', 0)');

          ctx.fillStyle = haloGrad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }

        // Render either 4-Point Celestial Star or Round Drifting Sparkle
        if (p.isStar) {
          drawFourPointStar(p.x, p.y, p.radius, p.rot, colorStr, alpha, light);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = colorStr;
          ctx.fill();
        }
      }

      animFrame = requestAnimationFrame(render);
    }

    // =========================================================================
    // Theme Adaptation & Lifecycle Observers
    // =========================================================================
    if (window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
          if (mutations[m].attributeName === 'data-theme') {
            refreshPalettes();
            break;
          }
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
      }, 150);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        isRunning = false;
        if (animFrame) cancelAnimationFrame(animFrame);
      } else {
        if (!isRunning) {
          isRunning = true;
          render();
        }
      }
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSparkles);
  } else {
    initSparkles();
  }
})();
