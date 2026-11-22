/**
 * DevNexus Analytics Vector Chart Engine (Dependency-Free SVG + Interactive Tooltips)
 * Renders all 12 developer productivity charts consistently with dark/light theme CSS vars.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var tooltipEl = null;

  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'dn-analytics-tooltip';
    tooltipEl.className = 'dn-analytics-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showTooltip(evt, title, lines) {
    var tip = ensureTooltip();
    var html = '<div class="dn-tip-title">' + escapeHtml(title) + '</div>';
    if (Array.isArray(lines) && lines.length > 0) {
      html += lines.map(function (line) {
        return '<div class="dn-tip-line">' + escapeHtml(line) + '</div>';
      }).join('');
    }
    tip.innerHTML = html;
    tip.style.display = 'block';

    var x = evt.clientX + 14;
    var y = evt.clientY - 10;
    var rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 12) {
      x = Math.max(8, evt.clientX - rect.width - 14);
    }
    if (y + rect.height > window.innerHeight - 12) {
      y = Math.max(8, window.innerHeight - rect.height - 12);
    }
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function svgEl(tag, attrs, parent) {
    var el = document.createElementNS(NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, String(attrs[k]));
      });
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  function renderEmptyState(container, title, subtitle) {
    container.innerHTML =
      '<div class="dn-chart-empty">' +
      '<div class="dn-chart-empty-title">' + escapeHtml(title || 'No verified activity yet') + '</div>' +
      '<div class="dn-chart-empty-sub">' + escapeHtml(subtitle || 'Sync your GitHub account or adjust your date filter.') + '</div>' +
      '</div>';
  }

  function attachTip(el, title, linesFn) {
    el.style.cursor = 'pointer';
    el.addEventListener('mouseenter', function (e) {
      var lines = typeof linesFn === 'function' ? linesFn() : linesFn;
      showTooltip(e, title, lines);
    });
    el.addEventListener('mousemove', function (e) {
      var lines = typeof linesFn === 'function' ? linesFn() : linesFn;
      showTooltip(e, title, lines);
    });
    el.addEventListener('mouseleave', hideTooltip);
  }

  function createSvgCanvas(container, width, height) {
    container.innerHTML = '';
    return svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      class: 'dn-svg-chart',
      role: 'img'
    }, container);
  }

  function drawGridAndYAxis(svg, pad, plotW, plotH, maxVal, steps) {
    var s = steps || 4;
    for (var i = 0; i <= s; i++) {
      var ratio = i / s;
      var y = pad.top + plotH - (plotH * ratio);
      var val = Math.round(maxVal * ratio);
      svgEl('line', {
        x1: pad.left,
        y1: y,
        x2: pad.left + plotW,
        y2: y,
        stroke: 'var(--border)',
        'stroke-dasharray': i === 0 ? 'none' : '3 3',
        'stroke-width': 1
      }, svg);
      var lbl = svgEl('text', {
        x: pad.left - 8,
        y: y + 4,
        'text-anchor': 'end',
        fill: 'var(--muted)',
        'font-size': 10,
        'font-family': 'var(--mono)'
      }, svg);
      lbl.textContent = String(val);
    }
  }

  // 1 & 2. Vertical Bar Chart (Monthly Daily Activity OR Quarterly Comparison)
  function renderBarChart(container, items, opts) {
    opts = opts || {};
    var hasAny = Array.isArray(items) && items.some(function (it) { return (Number(it.value) || 0) > 0; });
    if (!Array.isArray(items) || items.length === 0 || (!hasAny && !opts.renderZeroAxis)) {
      renderEmptyState(container, opts.emptyTitle, opts.emptySub);
      return;
    }

    var W = 540;
    var H = 210;
    var pad = { top: 18, right: 12, bottom: 28, left: 36 };
    var plotW = W - pad.left - pad.right;
    var plotH = H - pad.top - pad.bottom;
    var maxVal = Math.max(4, Math.max.apply(null, items.map(function (i) { return Number(i.value) || 0; })));

    var svg = createSvgCanvas(container, W, H);
    drawGridAndYAxis(svg, pad, plotW, plotH, maxVal, 4);

    var n = items.length;
    var step = plotW / Math.max(1, n);
    var barW = Math.max(4, Math.min(34, step * 0.65));
    var labelEvery = n > 16 ? Math.ceil(n / 10) : 1;

    items.forEach(function (item, idx) {
      var v = Math.max(0, Number(item.value) || 0);
      var barH = maxVal > 0 ? (v / maxVal) * plotH : 0;
      var x = pad.left + (idx * step) + ((step - barW) / 2);
      var y = pad.top + plotH - barH;
      var color = item.active ? (opts.highlightColor || 'var(--cyan)') : (item.color || opts.color || 'var(--accent-solid)');

      if (barH > 0) {
        var rect = svgEl('rect', {
          x: x,
          y: y,
          width: barW,
          height: Math.max(2, barH),
          rx: 3,
          fill: color,
          opacity: item.muted ? 0.45 : 0.9
        }, svg);
        attachTip(rect, item.tipTitle || item.label, item.tipLines || [String(v) + ' contributions']);
      } else {
        var hit = svgEl('rect', {
          x: x,
          y: pad.top + plotH - 8,
          width: barW,
          height: 8,
          fill: 'transparent'
        }, svg);
        attachTip(hit, item.tipTitle || item.label, item.tipLines || ['0 contributions']);
      }

      if (opts.showValueLabels && v > 0) {
        var valTxt = svgEl('text', {
          x: x + (barW / 2),
          y: Math.max(12, y - 5),
          'text-anchor': 'middle',
          fill: 'var(--text)',
          'font-size': 10,
          'font-weight': 600
        }, svg);
        valTxt.textContent = String(v);
      }

      if (idx % labelEvery === 0 || idx === n - 1) {
        var lbl = svgEl('text', {
          x: x + (barW / 2),
          y: H - 8,
          'text-anchor': 'middle',
          fill: 'var(--muted)',
          'font-size': 10
        }, svg);
        lbl.textContent = String(item.label || '');
      }
    });
  }

  // 3. Line / Area Trend Chart (Yearly 12-Month Trend)
  function renderLineTrendChart(container, points, opts) {
    opts = opts || {};
    var hasAny = Array.isArray(points) && points.some(function (p) { return (Number(p.value) || 0) > 0; });
    if (!Array.isArray(points) || points.length === 0 || !hasAny) {
      renderEmptyState(container, opts.emptyTitle, opts.emptySub);
      return;
    }

    var W = 540;
    var H = 215;
    var pad = { top: 20, right: 16, bottom: 28, left: 36 };
    var plotW = W - pad.left - pad.right;
    var plotH = H - pad.top - pad.bottom;
    var maxVal = Math.max(4, Math.max.apply(null, points.map(function (p) { return Number(p.value) || 0; })));

    var svg = createSvgCanvas(container, W, H);
    drawGridAndYAxis(svg, pad, plotW, plotH, maxVal, 4);

    var n = points.length;
    var coords = points.map(function (p, i) {
      var x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
      var y = pad.top + plotH - (((Number(p.value) || 0) / maxVal) * plotH);
      return { x: x, y: y, item: p };
    });

    var linePath = coords.map(function (c, idx) {
      return (idx === 0 ? 'M ' : 'L ') + c.x.toFixed(1) + ' ' + c.y.toFixed(1);
    }).join(' ');

    var areaPath = linePath +
      ' L ' + coords[coords.length - 1].x.toFixed(1) + ' ' + (pad.top + plotH) +
      ' L ' + coords[0].x.toFixed(1) + ' ' + (pad.top + plotH) + ' Z';

    svgEl('path', {
      d: areaPath,
      fill: opts.areaColor || 'rgba(99, 102, 241, 0.16)'
    }, svg);

    svgEl('path', {
      d: linePath,
      fill: 'none',
      stroke: opts.strokeColor || 'var(--accent-solid)',
      'stroke-width': 2.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    }, svg);

    coords.forEach(function (c) {
      var dot = svgEl('circle', {
        cx: c.x.toFixed(1),
        cy: c.y.toFixed(1),
        r: c.item.value > 0 ? 4 : 2.5,
        fill: c.item.value > 0 ? 'var(--cyan)' : 'var(--muted)',
        stroke: 'var(--bg)',
        'stroke-width': 1.5
      }, svg);
      attachTip(dot, c.item.tipTitle || c.item.label, c.item.tipLines || [String(c.item.value) + ' contributions']);

      var lbl = svgEl('text', {
        x: c.x.toFixed(1),
        y: H - 8,
        'text-anchor': 'middle',
        fill: 'var(--muted)',
        'font-size': 10
      }, svg);
      lbl.textContent = String(c.item.label || '');
    });
  }

  // 4 & 5. Grouped Multi-Series Bar Chart (Commits vs PRs / Issues Opened vs Closed)
  function renderGroupedBarChart(container, groups, seriesDefs, opts) {
    opts = opts || {};
    var hasAny = Array.isArray(groups) && groups.some(function (g) {
      return seriesDefs.some(function (s) { return (Number(g[s.key]) || 0) > 0; });
    });
    if (!Array.isArray(groups) || groups.length === 0 || !hasAny) {
      renderEmptyState(container, opts.emptyTitle, opts.emptySub);
      return;
    }

    var W = 540;
    var H = 220;
    var pad = { top: 26, right: 12, bottom: 28, left: 36 };
    var plotW = W - pad.left - pad.right;
    var plotH = H - pad.top - pad.bottom;

    var maxVal = 4;
    groups.forEach(function (g) {
      seriesDefs.forEach(function (s) {
        var v = Number(g[s.key]) || 0;
        if (v > maxVal) maxVal = v;
      });
    });

    var svg = createSvgCanvas(container, W, H);
    drawGridAndYAxis(svg, pad, plotW, plotH, maxVal, 4);

    // Inline SVG legend at top
    var legendX = pad.left;
    seriesDefs.forEach(function (s) {
      svgEl('rect', { x: legendX, y: 5, width: 9, height: 9, rx: 2, fill: s.color }, svg);
      var lt = svgEl('text', { x: legendX + 13, y: 13, fill: 'var(--muted)', 'font-size': 10.5 }, svg);
      lt.textContent = s.label;
      legendX += (s.label.length * 6.5) + 28;
    });

    var groupStep = plotW / Math.max(1, groups.length);
    var innerW = groupStep * 0.72;
    var subBarW = Math.max(4, Math.min(18, (innerW / seriesDefs.length) - 2));

    groups.forEach(function (g, gIdx) {
      var groupLeft = pad.left + (gIdx * groupStep) + ((groupStep - (subBarW * seriesDefs.length + (seriesDefs.length - 1) * 2)) / 2);
      seriesDefs.forEach(function (s, sIdx) {
        var v = Math.max(0, Number(g[s.key]) || 0);
        var bH = maxVal > 0 ? (v / maxVal) * plotH : 0;
        var x = groupLeft + sIdx * (subBarW + 2);
        var y = pad.top + plotH - bH;
        if (bH > 0) {
          var r = svgEl('rect', {
            x: x,
            y: y,
            width: subBarW,
            height: Math.max(2, bH),
            rx: 2,
            fill: s.color
          }, svg);
          attachTip(r, (g.fullLabel || g.label) + ' \u2014 ' + s.label, [
            s.label + ': ' + v,
            seriesDefs.map(function (sd) { return sd.label + ': ' + (Number(g[sd.key]) || 0); }).join(' | ')
          ]);
        }
      });

      var lbl = svgEl('text', {
        x: pad.left + (gIdx * groupStep) + (groupStep / 2),
        y: H - 8,
        'text-anchor': 'middle',
        fill: 'var(--muted)',
        'font-size': 10
      }, svg);
      lbl.textContent = String(g.label || '');
    });
  }

  // 6. GitHub Contribution Calendar Heatmap
  function renderHeatmap(container, heatmap) {
    if (!heatmap || !Array.isArray(heatmap.days) || heatmap.days.length === 0) {
      renderEmptyState(container, 'No contribution heatmap data', 'Sync GitHub to view daily activity intensity.');
      return;
    }

    var days = heatmap.days;
    var firstDow = days[0].dayOfWeek || 0;
    var padded = [];
    for (var p = 0; p < firstDow; p++) padded.push(null);
    for (var d = 0; d < days.length; d++) padded.push(days[d]);
    var numCols = Math.ceil(padded.length / 7);

    var cellSize = 11;
    var gap = 3;
    var leftMargin = 28;
    var topMargin = 20;
    var W = leftMargin + numCols * (cellSize + gap) + 8;
    var H = topMargin + 7 * (cellSize + gap) + 26;

    var wrap = document.createElement('div');
    wrap.className = 'dn-heatmap-scroll';
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      style: 'min-width:' + Math.min(760, W) + 'px; width:100%; height:auto; display:block;',
      role: 'img'
    }, wrap);

    ['Mon', 'Wed', 'Fri'].forEach(function (label, idx) {
      var row = idx === 0 ? 1 : (idx === 1 ? 3 : 5);
      var t = svgEl('text', {
        x: 0,
        y: topMargin + row * (cellSize + gap) + 9,
        fill: 'var(--muted)',
        'font-size': 9.5
      }, svg);
      t.textContent = label;
    });

    var palette = [
      'var(--l0)',
      'var(--l1)',
      'var(--l2)',
      'var(--l3)',
      'var(--l4)'
    ];
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var lastLabeledMonth = -1;

    padded.forEach(function (cell, index) {
      if (!cell) return;
      var col = Math.floor(index / 7);
      var row = index % 7;
      var x = leftMargin + col * (cellSize + gap);
      var y = topMargin + row * (cellSize + gap);

      if (row === 0 && cell.date) {
        var m = parseInt(cell.date.slice(5, 7), 10) - 1;
        if (m !== lastLabeledMonth) {
          lastLabeledMonth = m;
          var mt = svgEl('text', {
            x: x,
            y: 12,
            fill: 'var(--muted)',
            'font-size': 9.5
          }, svg);
          mt.textContent = monthNames[m] || '';
        }
      }

      var lvl = Math.max(0, Math.min(4, Number(cell.level) || 0));
      var rect = svgEl('rect', {
        x: x,
        y: y,
        width: cellSize,
        height: cellSize,
        rx: 3,
        fill: palette[lvl],
        stroke: 'var(--cell-edge)'
      }, svg);

      attachTip(rect, cell.date, [
        cell.count + ' verified contribution' + (cell.count === 1 ? '' : 's') + ' (' + cell.points + ' pts)',
        'Commits: ' + cell.commits + ' | PRs: ' + cell.prs + ' | Issues: ' + cell.issues + ' | Reviews: ' + cell.reviews
      ]);
    });

    // Legend row
    var legY = topMargin + 7 * (cellSize + gap) + 12;
    var lt1 = svgEl('text', { x: leftMargin, y: legY + 9, fill: 'var(--muted)', 'font-size': 9.5 }, svg);
    lt1.textContent = heatmap.totalContributions + ' contributions across ' + heatmap.activeDays + ' active day(s)';

    var legRightX = W - 115;
    var ltLess = svgEl('text', { x: legRightX - 28, y: legY + 9, fill: 'var(--muted)', 'font-size': 9.5 }, svg);
    ltLess.textContent = 'Less';
    palette.forEach(function (c, i) {
      svgEl('rect', { x: legRightX + i * 14, y: legY, width: 10, height: 10, rx: 2, fill: c, stroke: 'var(--cell-edge)' }, svg);
    });
    var ltMore = svgEl('text', { x: legRightX + 74, y: legY + 9, fill: 'var(--muted)', 'font-size': 9.5 }, svg);
    ltMore.textContent = 'More';

    container.innerHTML = '';
    container.appendChild(wrap);
  }

  // 7 & 11. Horizontal Ranked Bar Chart (Repositories OR Leaderboard)
  function renderHorizontalBarChart(container, rows, opts) {
    opts = opts || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      renderEmptyState(container, opts.emptyTitle, opts.emptySub);
      return;
    }

    var slice = rows.slice(0, opts.maxRows || 8);
    var maxVal = Math.max(1, Math.max.apply(null, slice.map(function (r) { return Number(r.value) || 0; })));
    var list = document.createElement('div');
    list.className = 'dn-hbar-list';

    slice.forEach(function (row) {
      var v = Number(row.value) || 0;
      var pct = Math.max(2, Math.round((v / maxVal) * 100));
      var item = document.createElement('div');
      item.className = 'dn-hbar-row' + (row.highlight ? ' is-highlight' : '');
      item.innerHTML =
        '<div class="dn-hbar-head">' +
        '<span class="dn-hbar-label">' + escapeHtml(row.label) +
        (row.badge ? ' <span class="dn-hbar-badge">' + escapeHtml(row.badge) + '</span>' : '') +
        '</span>' +
        '<span class="dn-hbar-val">' + escapeHtml(row.valueText || String(v)) + '</span>' +
        '</div>' +
        '<div class="dn-hbar-track"><div class="dn-hbar-fill" style="width:' + pct + '%;background:' + escapeHtml(row.color || 'var(--accent)') + '"></div></div>' +
        (row.sub ? '<div class="dn-hbar-sub">' + escapeHtml(row.sub) + '</div>' : '');

      if (row.tipTitle || row.tipLines) {
        attachTip(item, row.tipTitle || row.label, row.tipLines || [row.valueText || String(v)]);
      }
      list.appendChild(item);
    });

    container.innerHTML = '';
    container.appendChild(list);
  }

  // 8. Activity Percentage Gauge / Ring Chart
  function renderGaugeChart(container, pctObj) {
    if (!pctObj) {
      renderEmptyState(container, 'No activity rate recorded', 'Activity percentage calculates active days / eligible calendar days.');
      return;
    }

    var pct = Math.max(0, Math.min(100, Number(pctObj.activityPercentage) || 0));
    var r = 56;
    var circ = 2 * Math.PI * r;
    var dash = (pct / 100) * circ;
    var color = pct >= 60 ? '#22c55e' : (pct >= 25 ? 'var(--cyan)' : 'var(--accent-solid)');

    var W = 160;
    var H = 152;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'dn-gauge-svg', role: 'img' });
    svgEl('circle', {
      cx: 80, cy: 76, r: r,
      fill: 'none',
      stroke: 'var(--surface-2)',
      'stroke-width': 13
    }, svg);

    var arc = svgEl('circle', {
      cx: 80, cy: 76, r: r,
      fill: 'none',
      stroke: color,
      'stroke-width': 13,
      'stroke-linecap': 'round',
      'stroke-dasharray': dash.toFixed(1) + ' ' + circ.toFixed(1),
      transform: 'rotate(-90 80 76)'
    }, svg);
    attachTip(arc, pctObj.label || 'Activity Rate', [
      'Activity Percentage: ' + pct + '%',
      'Active Days: ' + (pctObj.activeDays || 0) + ' / ' + (pctObj.eligibleDays || 0) + ' eligible days',
      'Contributions: ' + (pctObj.totalContributions || 0)
    ]);

    var mainT = svgEl('text', {
      x: 80, y: 74, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 22, 'font-weight': 700
    }, svg);
    mainT.textContent = pct.toFixed(2).replace(/\.00$/, '') + '%';

    var subT = svgEl('text', {
      x: 80, y: 94, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10.5
    }, svg);
    subT.textContent = (pctObj.activeDays || 0) + ' / ' + (pctObj.eligibleDays || 0) + ' active days';

    container.innerHTML = '';
    container.appendChild(svg);
  }

  // 9. Signed Growth Delta Chart (+ / - Month-over-Month Growth)
  function renderGrowthDeltaChart(container, items, opts) {
    opts = opts || {};
    var hasAny = Array.isArray(items) && items.some(function (i) {
      return i.percentageChange !== null && i.percentageChange !== undefined && i.percentageChange !== 0;
    }) || (Array.isArray(items) && items.some(function (i) { return (i.current || 0) > 0; }));
    if (!Array.isArray(items) || items.length === 0 || !hasAny) {
      renderEmptyState(container, opts.emptyTitle, opts.emptySub);
      return;
    }

    var W = 540;
    var H = 210;
    var pad = { top: 18, right: 12, bottom: 28, left: 40 };
    var plotW = W - pad.left - pad.right;
    var plotH = H - pad.top - pad.bottom;

    var maxAbs = 50;
    items.forEach(function (i) {
      var val = i.percentageChange !== null && i.percentageChange !== undefined ? Math.abs(i.percentageChange) : 0;
      if (val > maxAbs) maxAbs = val;
    });
    maxAbs = Math.min(300, Math.ceil(maxAbs / 25) * 25);

    var svg = createSvgCanvas(container, W, H);
    var midY = pad.top + (plotH / 2);

    [-1, -0.5, 0, 0.5, 1].forEach(function (frac) {
      var y = midY - (frac * (plotH / 2));
      svgEl('line', {
        x1: pad.left, y1: y, x2: pad.left + plotW, y2: y,
        stroke: frac === 0 ? 'var(--muted)' : 'var(--border)',
        'stroke-dasharray': frac === 0 ? 'none' : '3 3',
        'stroke-width': frac === 0 ? 1.2 : 1
      }, svg);
      var lbl = svgEl('text', {
        x: pad.left - 6, y: y + 3, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 9.5
      }, svg);
      var val = Math.round(maxAbs * frac);
      lbl.textContent = (val > 0 ? '+' : '') + val + '%';
    });

    var step = plotW / Math.max(1, items.length);
    var barW = Math.max(6, Math.min(26, step * 0.6));

    items.forEach(function (item, idx) {
      var x = pad.left + idx * step + (step - barW) / 2;
      if (item.percentageChange === null || item.percentageChange === undefined) {
        // Prior period was 0 -> render neutral cyan baseline marker instead of misleading +100%
        if ((item.current || 0) > 0) {
          var marker = svgEl('rect', {
            x: x, y: midY - 12, width: barW, height: 12, rx: 2, fill: 'rgba(34, 211, 238, 0.65)'
          }, svg);
          attachTip(marker, item.label, [item.displayText || ('+' + item.current + ' vs 0 prior'), 'Percentage N/A when prior period is 0']);
        }
      } else {
        var clamped = Math.max(-maxAbs, Math.min(maxAbs, item.percentageChange));
        var h = (Math.abs(clamped) / maxAbs) * (plotH / 2);
        var y = clamped >= 0 ? (midY - h) : midY;
        var bar = svgEl('rect', {
          x: x, y: y, width: barW, height: Math.max(2, h), rx: 2,
          fill: clamped > 0 ? 'var(--success)' : (clamped < 0 ? 'var(--danger)' : 'var(--muted)')
        }, svg);
        attachTip(bar, item.label, [
          'MoM Growth: ' + (item.displayText || '0%'),
          'Current: ' + (item.current || 0) + ' | Prior: ' + (item.previous || 0)
        ]);
      }

      var lbl = svgEl('text', {
        x: x + barW / 2, y: H - 8, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10
      }, svg);
      lbl.textContent = String(item.label || '');
    });
  }

  // 10. Contribution Streak 30-Day History Strip
  function renderStreakHistory(container, streak) {
    if (!streak || !Array.isArray(streak.recentMonth) || streak.recentMonth.length === 0) {
      renderEmptyState(container, 'No qualifying streak days recorded', 'Push commits, open PRs, resolve issues, or complete roadmap steps to build your streak.');
      return;
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'dn-streak-viz';

    var kpis = document.createElement('div');
    kpis.className = 'dn-streak-kpis';
    kpis.innerHTML =
      '<div class="dn-streak-kpi"><span class="val">' + (streak.current_streak || 0) + 'd</span><span class="lbl">Current Streak</span></div>' +
      '<div class="dn-streak-kpi"><span class="val">' + (streak.longest_streak || 0) + 'd</span><span class="lbl">Longest Streak</span></div>' +
      '<div class="dn-streak-kpi"><span class="val">' + (streak.total_active_days || 0) + '</span><span class="lbl">Qualifying Days</span></div>' +
      '<div class="dn-streak-kpi"><span class="val">' + (streak.streak_freeze_count || 0) + '</span><span class="lbl">Freeze Shields</span></div>';
    wrapper.appendChild(kpis);

    var strip = document.createElement('div');
    strip.className = 'dn-streak-cells';
    streak.recentMonth.forEach(function (day) {
      var cell = document.createElement('div');
      cell.className = 'dn-streak-cell' + (day.active ? ' active' : '') + (day.isToday ? ' today' : '');
      attachTip(cell, day.date + ' (' + day.dayName + ')', [
        day.active ? 'Qualifying contribution recorded' : 'No qualifying contribution on this date',
        day.isToday ? 'Reference day (Today)' : ''
      ].filter(Boolean));
      strip.appendChild(cell);
    });
    wrapper.appendChild(strip);

    var footer = document.createElement('div');
    footer.className = 'dn-streak-caption';
    footer.textContent = streak.statusMessage || 'Last 30 days qualifying contribution timeline (visits & logins excluded)';
    wrapper.appendChild(footer);

    container.innerHTML = '';
    container.appendChild(wrapper);
  }

  // 12. Shared Doughnut Chart (Language Distribution or Repository Activity Distribution)
  function renderDoughnutChart(container, items, opts) {
    opts = opts || {};
    if (!container) return;
    if (!Array.isArray(items) || items.length === 0) {
      renderEmptyState(
        container,
        opts.emptyTitle || 'No distribution data yet',
        opts.emptySub || 'Connect and sync GitHub repositories to inspect breakdown.'
      );
      return;
    }

    var palette = opts.palette || ['#6366f1', '#22d3ee', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#94a3b8'];
    var sliced = items.slice(0, 8);
    var total = sliced.reduce(function (sum, item) { return sum + (Number(item.count || item.value) || 0); }, 0);
    if (total <= 0) {
      renderEmptyState(
        container,
        opts.emptyTitle || 'No distribution data yet',
        opts.emptySub || 'Items without measurable activity are excluded.'
      );
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'dn-donut-wrap';

    var svg = svgEl('svg', { viewBox: '0 0 150 150', class: 'dn-donut-svg', role: 'img' }, wrap);
    var r = 52;
    var circ = 2 * Math.PI * r;
    var offset = 0;

    sliced.forEach(function (item, idx) {
      var val = Number(item.count || item.value) || 0;
      var frac = val / total;
      var segLen = frac * circ;
      var pct = item.percentage !== undefined && item.percentage !== null
        ? Number(item.percentage)
        : Math.round(frac * 1000) / 10;
      var label = item.label || item.language || 'Unknown';
      var unitSing = opts.countUnitSingular || 'item';
      var unitPlur = opts.countUnitPlural || 'items';
      var tipLines = Array.isArray(item.tooltipLines) && item.tooltipLines.length > 0
        ? item.tooltipLines
        : [val + ' ' + (val === 1 ? unitSing : unitPlur) + ' (' + pct + '%)'];

      var c = palette[idx % palette.length];
      var seg = svgEl('circle', {
        cx: 75, cy: 75, r: r,
        fill: 'none',
        stroke: c,
        'stroke-width': 18,
        'stroke-dasharray': segLen.toFixed(2) + ' ' + circ.toFixed(2),
        'stroke-dashoffset': (-offset).toFixed(2),
        transform: 'rotate(-90 75 75)'
      }, svg);
      attachTip(seg, item.tooltipTitle || label, tipLines);
      offset += segLen;
    });

    var centerNum = svgEl('text', { x: 75, y: 74, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 18, 'font-weight': 700 }, svg);
    centerNum.textContent = String(opts.centerCount !== undefined ? opts.centerCount : items.length);
    var centerSub = svgEl('text', { x: 75, y: 90, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10 }, svg);
    centerSub.textContent = opts.centerSubLabel || 'items';

    var legend = document.createElement('div');
    legend.className = 'dn-donut-legend';
    sliced.forEach(function (item, idx) {
      var val = Number(item.count || item.value) || 0;
      var frac = val / total;
      var pct = item.percentage !== undefined && item.percentage !== null
        ? Number(item.percentage)
        : Math.round(frac * 1000) / 10;
      var label = item.label || item.language || 'Unknown';
      var c = palette[idx % palette.length];
      var row = document.createElement('div');
      row.className = 'dn-donut-leg-item';
      row.innerHTML =
        '<span class="dn-donut-dot" style="background:' + c + '"></span>' +
        '<span class="dn-donut-name" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>' +
        '<span class="dn-donut-pct">' + escapeHtml(String(pct)) + '% (' + val + ')</span>';
      legend.appendChild(row);
    });

    wrap.appendChild(legend);
    container.innerHTML = '';
    container.appendChild(wrap);
  }

  function renderLanguageDonut(container, langs) {
    renderDoughnutChart(
      container,
      (Array.isArray(langs) ? langs : []).map(function (l) {
        return {
          label: l.language,
          count: l.count,
          percentage: l.percentage
        };
      }),
      {
        centerSubLabel: 'languages',
        countUnitSingular: 'repository',
        countUnitPlural: 'repositories',
        emptyTitle: 'No repository language data',
        emptySub: 'Connect and sync GitHub repositories to inspect language distribution.'
      }
    );
  }

  global.DevNexusCharts = {
    renderEmptyState: renderEmptyState,
    renderBarChart: renderBarChart,
    renderLineTrendChart: renderLineTrendChart,
    renderGroupedBarChart: renderGroupedBarChart,
    renderHeatmap: renderHeatmap,
    renderHorizontalBarChart: renderHorizontalBarChart,
    renderGaugeChart: renderGaugeChart,
    renderGrowthDeltaChart: renderGrowthDeltaChart,
    renderStreakHistory: renderStreakHistory,
    renderDoughnutChart: renderDoughnutChart,
    renderLanguageDonut: renderLanguageDonut
  };
})(window);
