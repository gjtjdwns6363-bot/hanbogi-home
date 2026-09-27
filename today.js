// /today/ 오늘 실거래가 — /data/<시군구>.json 을 받아 거르고 카드로 그린다. 의존성 없음.
(function () {
  var $ = function (i) { return document.getElementById(i); };
  var R = JSON.parse($('regions').textContent); // [[code, sido, name]]
  var VIEWS = {
    tr: ['매매 실거래', function (x) { return x.v === 't'; }],
    trec: ['매매 신고가', function (x) { return x.v === 't' && x.r; }],
    up: ['매매 상승거래', function (x) { return x.v === 't' && !x.x && x.pv && x.p > x.pv[0]; }],
    down: ['매매 하락거래', function (x) { return x.v === 't' && !x.x && x.pv && x.p < x.pv[0]; }],
    j: ['전세 실거래', function (x) { return x.v === 'j'; }],
    jrec: ['전세 신고가', function (x) { return x.v === 'j' && x.r; }],
    w: ['월세 실거래', function (x) { return x.v === 'w'; }]
  };
  var q = new URLSearchParams(location.search), view = VIEWS[q.get('v')] ? q.get('v') : 'tr', D = null, n = 50;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  function won(m) { m = Math.round(m); var e = Math.floor(Math.abs(m) / 10000), r = Math.abs(m) % 10000; return (m < 0 ? '-' : '') + (e ? e + '억' + (r || '') : String(r)); } // 6억2800
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function md(s) { return s.slice(2).replace(/-/g, '.'); }
  function days(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  function band(a) { return a <= 60 ? '0' : a <= 85 ? '1' : a <= 135 ? '2' : '3'; }
  function opt(sel, list, keep) { var v = sel.value; sel.innerHTML = list.map(function (o) { return '<option value="' + h(o[0]) + '">' + h(o[1]) + '</option>'; }).join(''); if (keep) sel.value = v; if (sel.selectedIndex < 0) sel.selectedIndex = 0; }

  // 시도 → 시군구
  var sidos = []; R.forEach(function (r) { if (sidos.indexOf(r[1]) < 0) sidos.push(r[1]); });
  opt($('sd'), sidos.map(function (s) { return [s, s]; }));
  function fillSg() { opt($('sg'), R.filter(function (r) { return r[1] === $('sd').value; }).map(function (r) { return [r[0], r[2]]; })); }
  var start = q.get('c') || store.get('today-c') || '11680', sr = R.filter(function (r) { return r[0] === start; })[0] || R[0];
  $('sd').value = sr[1]; fillSg(); $('sg').value = sr[0];

  function load() {
    var code = $('sg').value;
    $('sum').textContent = '불러오는 중…'; $('list').innerHTML = '';
    fetch('/data/' + code + '.json').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
      D = d; store.set('today-c', code);
      var um = []; d.deals.forEach(function (x) { if (um.indexOf(x.u) < 0) um.push(x.u); }); um.sort();
      opt($('um'), [['', '전체 읍면동']].concat(um.map(function (u) { return [u, u]; })));
      var seen = []; d.deals.forEach(function (x) { if (x.s && seen.indexOf(x.s) < 0) seen.push(x.s); }); seen.sort().reverse();
      opt($('dt'), seen.slice(0, 14).map(function (s) { return ['s:' + s, s + ' 신고분']; }).concat([['c:7', '계약일 최근 7일'], ['c:all', '최근 두 달 전체']]));
      if (!seen.length && !d.deals.some(function (x) { return days(x.d, d.date) <= 7; })) $('dt').value = 'c:all';
      draw();
    }).catch(function () { D = null; $('sum').textContent = '자료를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.'; });
  }

  function spark(pts, cur) {
    if (!pts || pts.length < 2) return '<div class="spark hint">거래 1건</div>';
    var ps = pts.map(function (e) { return e[1]; }), lo = Math.min.apply(0, ps), hi = Math.max.apply(0, ps), W = 72, H = 40;
    var xy = pts.map(function (e, i) { return [2 + i * (W - 4) / (pts.length - 1), H - 3 - (hi === lo ? (H - 6) / 2 : (e[1] - lo) * (H - 6) / (hi - lo))]; });
    var dot = ''; pts.forEach(function (e, i) { if (e[0] === cur) dot = '<circle cx="' + xy[i][0].toFixed(1) + '" cy="' + xy[i][1].toFixed(1) + '" r="2.5"/>'; });
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="최근 ' + pts.length + '건 가격 추이 (최저 ' + won(lo) + ', 최고 ' + won(hi) + ')"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="' +
      xy.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>' + dot + '</svg>';
  }
  function pfd(e) { return won(e[0]) + ' (' + h(e[1]) + '층) <span class="hint">' + md(e[2]) + '</span>'; }
  function change(p, base) {
    var d = p - base, pc = (d / base * 100).toFixed(1);
    return d > 0 ? '<span class="up">↑ +' + d + ' (' + pc + '%)</span>' : d < 0 ? '<span class="down">↓ ' + d + ' (' + pc + '%)</span>' : '<span class="hint">변동 없음</span>';
  }
  function card(x, i) {
    var yr = +D.date.slice(0, 4), q2 = encodeURIComponent(D.name + ' ' + x.u + ' ' + x.a), sale = x.v === 't';
    var s = '<li class="deal"><div class="dl"><b class="rank">' + (i + 1) + '위</b>' + (x.v === 'w' ? '' : spark(D.K[x.k] && D.K[x.k][sale ? 't' : 'j'], +x.d.replace(/-/g, ''))) + '</div><div class="dm">' +
      '<h3>' + h(x.a) + '</h3><p class="hint addr">' + h(D.name + ' ' + x.u) + (x.y ? ' · ' + x.y + '년 준공(' + (yr - x.y + 1) + '년차)' : '') +
      ' · <a href="https://map.naver.com/p/search/' + q2 + '" target="_blank" rel="noopener nofollow">네이버지도</a> · <a href="https://map.kakao.com/?q=' + q2 + '" target="_blank" rel="noopener nofollow">카카오맵</a></p><p class="badges">' +
      '<span class="b ' + x.v + '">' + (sale ? '매매' : x.v === 'j' ? '전세' : '월세') + '</span>' + (x.g ? '<span class="b g">직거래</span>' : '') + (x.r ? '<span class="b fire">🔥신고가</span>' : '') +
      (x.x ? '<span class="b x">계약 취소</span>' : '') + (x.ct ? '<span class="b">' + h(x.ct) + '</span>' : '') + (x.s ? ' <span class="hint">' + days(x.d, x.s) + '일 후 등록됨</span>' : '') + '</p>';
    s += '<p class="price">' + (x.v === 'w' ? won(x.p) + ' / 월 ' + x.m : won(x.p)) + (x.pv ? ' ' + change(x.p, x.pv[0]) : '') + '</p>';
    s += '<ul class="chips sm"><li>' + h(x.f) + '층</li><li>전용 ' + x.ar + '㎡</li><li>계약 ' + md(x.d) + '</li></ul>';
    if (x.v !== 'w') {
      s += '<dl class="kv">';
      s += '<dt>직전거래</dt><dd>' + (x.pv ? pfd(x.pv) : '<span class="hint">없음 (3년 내 첫 거래)</span>') + '</dd>';
      if (x.hi) s += '<dt>3년 최고</dt><dd>' + pfd(x.hi) + ' · ' + (x.r ? '<b class="up">경신</b>' : '회복률 ' + Math.round(x.p / x.hi[0] * 100) + '%') + '</dd><dt>3년 최저</dt><dd>' + pfd(x.lo) + '</dd>';
      if (x.o) s += sale
        ? '<dt>전세 최근</dt><dd>' + pfd(x.o) + ' · 갭 ' + won(x.p - x.o[0]) + ' · 전세가율 ' + Math.round(x.o[0] / x.p * 100) + '%</dd>'
        : '<dt>매매 최근</dt><dd>' + pfd(x.o) + ' · 전세가율 ' + Math.round(x.p / x.o[0] * 100) + '%</dd>';
      s += '</dl>';
    }
    return s + '</div></li>';
  }

  function draw() {
    if (!D) return;
    var um = $('um').value, bd = $('bd').value, dt = $('dt').value, today = D.date;
    var L = D.deals.filter(function (x) {
      if (um && x.u !== um) return false;
      if (bd && band(x.ar) !== bd) return false;
      if (dt.slice(0, 2) === 's:') return x.s === dt.slice(2);
      if (dt === 'c:7') return days(x.d, today) <= 7;
      return true;
    });
    var byType = L.filter(VIEWS[view][1]);
    var sortKey = view === 'up' ? function (x) { return (x.p - x.pv[0]) / x.pv[0]; } : view === 'down' ? function (x) { return (x.pv[0] - x.p) / x.pv[0]; } : function (x) { return x.p + (x.m || 0) * 100; };
    byType.sort(function (a, b) { return sortKey(b) - sortKey(a); });
    var cx = byType.filter(function (x) { return x.x; }).length, sel = $('dt').options[$('dt').selectedIndex];
    $('sum').innerHTML = '<b>' + h(sel ? sel.text : '') + '</b> 아파트 ' + VIEWS[view][0] + ' · ' + h(D.sido + ' ' + D.name + (um ? ' ' + um : '')) + ' (총 ' + byType.length + '건' + (cx ? ', ' + cx + '건 취소포함' : '') + ')';
    $('list').innerHTML = byType.slice(0, n).map(card).join('') || '<li class="hint">해당 거래가 없어요. 기간을 “최근 두 달 전체”로 바꿔 보세요.</li>';
    $('more').hidden = byType.length <= n;
    [].forEach.call(document.querySelectorAll('.menu [data-v]'), function (b) { b.setAttribute('aria-pressed', b.dataset.v === view); });
    history.replaceState(null, '', '?c=' + D.code + '&v=' + view);
  }

  [].forEach.call(document.querySelectorAll('.menu [data-v]'), function (b) { b.onclick = function () { view = b.dataset.v; n = 50; draw(); }; });
  $('sd').onchange = function () { fillSg(); load(); };
  $('sg').onchange = load;
  $('um').onchange = $('bd').onchange = $('dt').onchange = function () { n = 50; draw(); };
  $('go').onclick = function () { n = 50; D && D.code === $('sg').value ? draw() : load(); };
  $('more').onclick = function () { n += 50; draw(); };
  load();
})();
