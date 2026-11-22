/**
 * DevNexus Landing Page — 3D Wireframe Polyhedra, Electric Light Trails & Mouse Parallax
 * Runs strictly on the landing page (#dx-wireframe-canvas / #dx-wow-bg).
 * Lightweight requestAnimationFrame engine with reduced-motion and tab-visibility guards.
 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  function initLandingWowBg() {
    var root = document.getElementById('dx-wow-bg');
    var canvas = document.getElementById('dx-wireframe-canvas');
    if (!root || !canvas) return;

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var width = window.innerWidth;
    var height = window.innerHeight;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    // Smooth lerped mouse parallax (-1 .. 1)
    var targetPx = 0;
    var targetPy = 0;
    var currentPx = 0;
    var currentPy = 0;

    window.addEventListener('pointermove', function (e) {
      if (!width || !height) return;
      targetPx = ((e.clientX / width) - 0.5) * 2;
      targetPy = ((e.clientY / height) - 0.5) * 2;
    }, { passive: true });

    // -----------------------------------------------------------------------
    // 3D Geometry Builders (Wireframe Polyhedra)
    // -----------------------------------------------------------------------
    function buildCube() {
      var v = [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1]
      ];
      var e = [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7],
        [0,2],[5,7]
      ];
      return { vertices: v, edges: e };
    }

    function buildOctahedron() {
      var v = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1]
      ];
      var e = [
        [2,0],[2,1],[2,4],[2,5],
        [3,0],[3,1],[3,4],[3,5],
        [0,4],[4,1],[1,5],[5,0]
      ];
      return { vertices: v, edges: e };
    }

    function buildIcosahedron() {
      var phi = (1 + Math.sqrt(5)) / 2;
      var norm = Math.sqrt(1 + phi * phi);
      var a = 1 / norm;
      var b = phi / norm;
      var v = [
        [-a,  b, 0], [ a,  b, 0], [-a, -b, 0], [ a, -b, 0],
        [0, -a,  b], [0,  a,  b], [0, -a, -b], [0,  a, -b],
        [ b, 0, -a], [ b, 0,  a], [-b, 0, -a], [-b, 0,  a]
      ];
      var e = [
        [0,1],[0,5],[0,7],[0,10],[0,11],
        [1,5],[1,7],[1,8],[1,9],
        [2,3],[2,4],[2,6],[2,10],[2,11],
        [3,4],[3,6],[3,8],[3,9],
        [4,5],[4,9],[4,11],
        [5,9],[5,11],
        [6,7],[6,8],[6,10],
        [7,8],[7,10],
        [8,9],[10,11]
      ];
      return { vertices: v, edges: e };
    }

    // Floating wireframe structures positioned carefully to frame content cleanly
    var shapes = [
      {
        geo: buildIcosahedron(),
        rx: 0.84, ry: 0.24,
        scale: 120,
        depth: 1.0,
        rotX: 0.4, rotY: 0.8, rotZ: 0.2,
        vx: 0.0022, vy: 0.0034, vz: 0.0014,
        floatAmp: 16, floatSpeed: 0.0008, floatPhase: 0.0,
        color: 'rgba(139, 92, 246, 0.34)',     // Rich violet
        nodeColor: 'rgba(34, 211, 238, 0.85)'   // Ice cyan nodes
      },
      {
        geo: buildOctahedron(),
        rx: 0.14, ry: 0.72,
        scale: 88,
        depth: 0.75,
        rotX: 0.9, rotY: 0.3, rotZ: 0.6,
        vx: -0.0028, vy: 0.0024, vz: 0.002,
        floatAmp: 14, floatSpeed: 0.0011, floatPhase: 2.1,
        color: 'rgba(59, 130, 246, 0.34)',      // Royal blue
        nodeColor: 'rgba(167, 139, 250, 0.85)'  // Soft purple nodes
      },
      {
        geo: buildCube(),
        rx: 0.50, ry: 0.14,
        scale: 56,
        depth: 0.48,
        rotX: 0.5, rotY: 0.5, rotZ: 0.1,
        vx: 0.0018, vy: -0.0021, vz: 0.0015,
        floatAmp: 10, floatSpeed: 0.0007, floatPhase: 4.3,
        color: 'rgba(34, 211, 238, 0.26)',      // Ice cyan
        nodeColor: 'rgba(99, 102, 241, 0.8)'
      },
      {
        geo: buildOctahedron(),
        rx: 0.90, ry: 0.78,
        scale: 72,
        depth: 0.62,
        rotX: 0.2, rotY: 1.1, rotZ: 0.4,
        vx: 0.0025, vy: -0.0030, vz: 0.0012,
        floatAmp: 12, floatSpeed: 0.0009, floatPhase: 1.4,
        color: 'rgba(99, 102, 241, 0.32)',      // Electric indigo
        nodeColor: 'rgba(34, 211, 238, 0.8)'
      },
      {
        geo: buildCube(),
        rx: 0.09, ry: 0.18,
        scale: 52,
        depth: 0.4,
        rotX: 1.1, rotY: 0.4, rotZ: 0.7,
        vx: -0.0019, vy: 0.0022, vz: -0.0016,
        floatAmp: 11, floatSpeed: 0.00095, floatPhase: 3.4,
        color: 'rgba(124, 58, 237, 0.28)',      // Subtle purple
        nodeColor: 'rgba(96, 165, 250, 0.75)'
      }
    ];

    // Electric-blue and violet light trails sweeping across deep space
    var trails = [];
    function spawnTrail(initial) {
      var isViolet = Math.random() < 0.45;
      var angle = (Math.random() * 0.45 - 0.22); // Gentle diagonal trajectory
      return {
        x: initial ? Math.random() * width : -120,
        y: Math.random() * height * 0.85 + height * 0.05,
        vx: (Math.random() * 1.4 + 1.1),
        vy: Math.sin(angle) * 0.6,
        len: Math.random() * 140 + 90,
        alpha: Math.random() * 0.28 + 0.18,
        color: isViolet ? [139, 92, 246] : [59, 130, 246],
        headColor: isViolet ? [196, 181, 253] : [34, 211, 238]
      };
    }
    for (var t = 0; t < 4; t++) {
      trails.push(spawnTrail(true));
    }

    function projectVertex(v, s, cx, cy) {
      var x = v[0], y = v[1], z = v[2];
      // Rotate X
      var cosX = Math.cos(s.rotX), sinX = Math.sin(s.rotX);
      var y1 = y * cosX - z * sinX;
      var z1 = y * sinX + z * cosX;
      // Rotate Y
      var cosY = Math.cos(s.rotY), sinY = Math.sin(s.rotY);
      var x2 = x * cosY + z1 * sinY;
      var z2 = -x * sinY + z1 * cosY;
      // Rotate Z
      var cosZ = Math.cos(s.rotZ), sinZ = Math.sin(s.rotZ);
      var x3 = x2 * cosZ - y1 * sinZ;
      var y3 = x2 * sinZ + y1 * cosZ;

      var fov = 3.2;
      var factor = fov / (fov - z2 * 0.65);
      return {
        x: cx + x3 * s.scale * factor,
        y: cy + y3 * s.scale * factor,
        z: z2
      };
    }

    var isRunning = true;
    var rafId = null;

    function frame(ts) {
      if (!isRunning) return;

      // Ease parallax smoothly
      currentPx += (targetPx - currentPx) * 0.06;
      currentPy += (targetPy - currentPy) * 0.06;
      root.style.setProperty('--px', currentPx.toFixed(4));
      root.style.setProperty('--py', currentPy.toFixed(4));

      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      ctx.clearRect(0, 0, width, height);

      // 1. Draw electric-blue & violet light trails
      for (var i = 0; i < trails.length; i++) {
        var tr = trails[i];
        tr.x += tr.vx;
        tr.y += tr.vy;
        if (tr.x - tr.len > width + 80 || tr.y < -100 || tr.y > height + 100) {
          trails[i] = spawnTrail(false);
          continue;
        }
        var tailX = tr.x - tr.len;
        var tailY = tr.y - (tr.vy / tr.vx) * tr.len;
        var grad = ctx.createLinearGradient(tailX, tailY, tr.x, tr.y);
        var baseA = isLight ? tr.alpha * 0.45 : tr.alpha;
        grad.addColorStop(0, 'rgba(' + tr.color[0] + ',' + tr.color[1] + ',' + tr.color[2] + ', 0)');
        grad.addColorStop(0.75, 'rgba(' + tr.color[0] + ',' + tr.color[1] + ',' + tr.color[2] + ',' + (baseA * 0.7) + ')');
        grad.addColorStop(1, 'rgba(' + tr.headColor[0] + ',' + tr.headColor[1] + ',' + tr.headColor[2] + ',' + baseA + ')');

        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tr.x, tr.y);
        ctx.stroke();

        ctx.fillStyle = 'rgba(' + tr.headColor[0] + ',' + tr.headColor[1] + ',' + tr.headColor[2] + ',' + (baseA * 1.4) + ')';
        ctx.beginPath();
        ctx.arc(tr.x, tr.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Draw slowly rotating floating 3D wireframes with depth parallax
      var responsiveScale = width < 720 ? 0.62 : 1;
      for (var sIdx = 0; sIdx < shapes.length; sIdx++) {
        var s = shapes[sIdx];
        s.rotX += s.vx + currentPy * 0.0005 * s.depth;
        s.rotY += s.vy + currentPx * 0.0007 * s.depth;
        s.rotZ += s.vz;

        var floatY = Math.sin(ts * s.floatSpeed + s.floatPhase) * s.floatAmp;
        var cx = width * s.rx + currentPx * -26 * s.depth;
        var cy = height * s.ry + floatY + currentPy * -22 * s.depth;

        var savedScale = s.scale;
        s.scale = savedScale * responsiveScale;
        var projected = [];
        for (var vIdx = 0; vIdx < s.geo.vertices.length; vIdx++) {
          projected.push(projectVertex(s.geo.vertices[vIdx], s, cx, cy));
        }
        s.scale = savedScale;

        // Wireframe edges
        ctx.save();
        ctx.globalAlpha = isLight ? 0.45 : 1;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (var eIdx = 0; eIdx < s.geo.edges.length; eIdx++) {
          var edge = s.geo.edges[eIdx];
          var p1 = projected[edge[0]];
          var p2 = projected[edge[1]];
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();

        // Glowing vertices
        ctx.fillStyle = s.nodeColor;
        for (var nIdx = 0; nIdx < projected.length; nIdx++) {
          var pt = projected[nIdx];
          var r = pt.z > 0 ? 2.1 : 1.3;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      rafId = requestAnimationFrame(frame);
    }

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        isRunning = false;
        if (rafId) cancelAnimationFrame(rafId);
      } else if (!isRunning) {
        isRunning = true;
        rafId = requestAnimationFrame(frame);
      }
    });

    rafId = requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLandingWowBg);
  } else {
    initLandingWowBg();
  }
})();
