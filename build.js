#!/usr/bin/env node
// 부동산 알리미 정적 사이트 생성기. 의존성 없음 (Node 20+ fetch).
//   node build.js             — 공공데이터포털 API 호출 (env DATA_GO_KR_KEY = 디코딩 키)
//   node build.js --fixtures  — fixtures/ 의 저장된 응답으로 생성 (키 불필요)
//   node build.js --from-cache — 마지막 실제 빌드가 남긴 원자료(history/_raw.json)로 다시 그린다. API 호출·저장소 쓰기 없음
'use strict';
const fs = require('fs');
const path = require('path');

const FIX = process.argv.includes('--fixtures');
const CACHE = process.argv.includes('--from-cache');
const RO = FIX || CACHE; // 저장소(history/)를 건드리지 않는 실행
const SITE = 'https://home.hanbogi.com';
const CALC = 'https://calc.hanbogi.com';
const OUT = path.join(__dirname, 'dist');
const CAP = +process.env.CAP || 4000; // API별 1회 실행 호출 상한 (일일 한도 10,000)
const FATAL_CODES = new Set(['12', '20', '21', '22', '30', '31', '32']); // 서비스 없음·접근거부·키 문제·한도 초과
const BANDS = ['60㎡ 이하', '60~85㎡', '85~135㎡', '135㎡ 초과'];
const ROW_LIMIT = 200; // 월별 표에 보여줄 최대 거래 수
const APT_MIN = 5; // 단지 페이지 색인 기준: 최근 3년 매매+전세 건수
const APT_HOT = 5000; // sitemap-apt-hot.xml 에 넣을 거래 많은 단지 수

// ---------- 순수 함수 (test.js에서 검사) ----------
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const toMan = (s) => parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10) || 0;
function fmtWon(man) { // 만원 → "12억 3,500만"
  man = Math.round(man);
  const eok = Math.floor(man / 10000), rest = man % 10000;
  if (!eok) return comma(rest) + '만';
  return eok + '억' + (rest ? ' ' + comma(rest) + '만' : '');
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
}
function normDate(s) { // "2026.09.01" | "20260901" | "2026-09-01" → "2026-09-01"
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
}
const areaBand = (a) => BANDS[a <= 60 ? 0 : a <= 85 ? 1 : a <= 135 ? 2 : 3];
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 국토부 RTMS XML (평평한 <item>) 또는 게이트웨이 오류 봉투 파싱
function parseRtms(xml) {
  const tag = (t) => { const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? dec(m[1]).trim() : null; };
  const reason = tag('returnReasonCode');
  if (reason) return { code: reason, msg: tag('returnAuthMsg') || tag('errMsg'), items: [] };
  const code = tag('resultCode');
  if (code == null) return { code: 'NOXML', msg: xml.slice(0, 120), items: [] };
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)].map((x) => [x[1], dec(x[2]).trim()])));
  return { code, msg: tag('resultMsg'), total: +tag('totalCount') || 0, items };
}

// ---------- 호출 ----------
const enc = encodeURIComponent(process.env.DATA_GO_KR_KEY || '');
const calls = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
const gate = {}; // API별 요청 간격. ponytail: 단순 간격 제한, 초당 한도가 더 빡빡하면 GAP만 늘린다
const GAP = 250;
async function pace(api) {
  const prev = gate[api] || Promise.resolve();
  let done; gate[api] = new Promise((r) => (done = r));
  await prev; setTimeout(done, GAP);
}
async function get(api, url) { // 오류 메시지에 URL(키 포함)을 절대 넣지 않는다
  for (let i = 0; ; i++) {
    await pace("all"); // 키 하나를 모든 API가 같이 쓰므로 간격도 하나로 묶는다
    if ((calls[api] = (calls[api] || 0) + 1) > CAP) throw fatal(`${api}: 호출 상한 ${CAP} 초과`);
    if (calls[api] % 100 === 0) console.log(`[진행] ${api} ${calls[api]}회 · ${new Date().toISOString().slice(11, 19)}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (r.status === 429 && /PER_SECOND/.test(text) && i < 8) { console.log(`[대기] ${api} 초당 한도, ${i + 1}번째 재시도`); await sleep(3000 * (i + 1)); continue; } // 초당 한도: 잠깐 쉬고 다시
      if ([401, 403, 429].includes(r.status)) throw fatal(`${api}: HTTP ${r.status} ${text.slice(0, 200)}`);
      if (!r.ok) throw new Error(`${api}: HTTP ${r.status} ${text.slice(0, 200)}`);
      return text;
    } catch (e) {
      if (e.fatal || i >= 2) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
function fixture(name, fallback) {
  const f = path.join(__dirname, 'fixtures', name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : fallback;
}
const EMPTY_XML = '<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header><body><items></items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount></body></response>';

async function rtms(op, lawd, ymd) { // op: RTMSDataSvcAptTradeDev | RTMSDataSvcAptRent
  const rows = [];
  for (let page = 1; page <= 30; page++) {
    const xml = FIX ? fixture(`${op}_${lawd}_${ymd}.xml`, EMPTY_XML)
      : await get(op, `https://apis.data.go.kr/1613000/${op}/get${op}?serviceKey=${enc}&LAWD_CD=${lawd}&DEAL_YMD=${ymd}&pageNo=${page}&numOfRows=1000`);
    const r = parseRtms(xml), c = String(+r.code);
    if (FATAL_CODES.has(c)) throw fatal(`${op}: 오류 ${r.code} ${r.msg}`);
    if (c !== '0' && c !== '3') throw new Error(`${op} ${lawd} ${ymd}: 오류 ${r.code} ${r.msg}`);
    rows.push(...r.items);
    if (!r.items.length || rows.length >= r.total) break;
  }
  return rows;
}

async function odcloud(op, params, fixName) { // 청약홈 (api.odcloud.kr, JSON)
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const qs = Object.entries({ page, perPage: 500, ...params }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const text = FIX ? fixture(fixName, '{"page":1,"perPage":500,"totalCount":0,"currentCount":0,"matchCount":0,"data":[]}')
      : await get('청약홈', `https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/${op}?serviceKey=${enc}&${qs}`);
    let j; try { j = JSON.parse(text); } catch { throw fatal(`청약홈 ${op}: JSON 아님 ${text.slice(0, 200)}`); }
    if (!Array.isArray(j.data)) throw fatal(`청약홈 ${op}: 오류 ${j.code} ${j.msg}`);
    out.push(...j.data);
    if (FIX || page * 500 >= (j.matchCount ?? j.totalCount ?? 0)) break;
  }
  return out;
}

async function lhNotices(since8, today8) { // LH 분양임대공고문 (JSON 배열 [{dsSch},{resHeader,dsList}])
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const text = FIX ? fixture('lh.json', '[]')
      : await get('LH', `https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1?serviceKey=${enc}&PG_SZ=100&PAGE=${page}&PAN_ST_DT=${since8}&PAN_ED_DT=${today8}`);
    let j; try { j = JSON.parse(text); } catch {
      const r = parseRtms(text); throw fatal(`LH: 오류 ${r.code} ${r.msg}`);
    }
    const body = (Array.isArray(j) ? j : []).find((x) => x.resHeader) || {};
    const ss = body.resHeader?.[0]?.SS_CODE;
    if (ss !== 'Y') throw fatal(`LH: SS_CODE=${ss} ${JSON.stringify(j).slice(0, 200)}`);
    const list = body.dsList || [];
    out.push(...list);
    if (FIX || !list.length || out.length >= +list[0].ALL_CNT) break;
  }
  return out;
}

// ---------- 신고가 (단지·전용면적별 거래 기록) ----------
// 키: aptSeq|전용㎡ 반올림 (aptSeq 없으면 시군구/동/단지/지번). 가격 0 = 제외 (매매 해제, 월세)
// 저장소 history/<시군구>.json = { t|r: { m: [채운 달], k: { 키: [[계약일 yyyymmdd, 만원, 층], ...] } }, seen: { 거래id: 처음 본 날 } }
const recKey = (r) => `${(r.aptSeq || '').trim() || [r.sggCd, r.umdNm, r.aptNm, r.jibun].join('/')}|${Math.round(+r.excluUseAr)}`;
const recPrice = (kind, r) => kind === 't' ? (r.cdealType === 'O' ? 0 : toMan(r.dealAmount)) : (toMan(r.monthlyRent) ? 0 : toMan(r.deposit));
const d8n = (r) => +dealDate(r).replace(/-/g, '');
const d8s = (n) => String(n).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3');
function putMonth(H, ym, kind, rows) { // 그 달 기록을 통째로 새 자료로 바꾼다 (해제·정정 반영)
  if (H.m.includes(ym)) for (const k of Object.keys(H.k)) {
    const l = H.k[k].filter((e) => String(e[0]).slice(0, 6) !== ym);
    if (l.length) H.k[k] = l; else delete H.k[k];
  }
  for (const r of rows) { const p = recPrice(kind, r); if (p) (H.k[recKey(r)] ||= []).push(kind === 'r' && (r.contractType || '').trim() === '갱신' ? [d8n(r), p, parseInt(r.floor, 10) || 0, 1] : [d8n(r), p, parseInt(r.floor, 10) || 0]); } // 전세 4번째 1 = 갱신
  if (!H.m.includes(ym)) H.m.push(ym);
}
function priorStats(list, d) { // 계약일 d보다 "이른" 거래만: 직전거래·최고·최저. 없으면 null
  let prev = null, hi = null, lo = null;
  for (const e of list || []) if (e[0] < d) {
    if (!prev || e[0] >= prev[0]) prev = e;
    if (!hi || e[1] > hi[1] || (e[1] === hi[1] && e[0] < hi[0])) hi = e;
    if (!lo || e[1] < lo[1]) lo = e;
  }
  return prev && { prev, hi, lo };
}
// 신고가: 같은 키에서 계약일이 더 이른 거래(저장 범위 최대 36개월)의 최고가보다 비싼 거래. 이전 거래가 없으면(첫 거래) 신고가 아님.
function findRecords(kind, rows, H) {
  const out = [];
  for (const r of rows) {
    const p = recPrice(kind, r), st = p && priorStats(H.k[recKey(r)], d8n(r));
    if (st && p > st.hi[1]) out.push({ r, p, key: recKey(r), d: dealDate(r), prev: st.hi[1], prevDate: d8s(st.hi[0]) });
  }
  return out;
}
const HIST = process.env.HIST_DIR || path.join(__dirname, 'history');
const RELIABLE = 12; // 이 개월 수 이상 모이면 신고가를 믿을 만하다고 본다
const emptyHist = () => ({ t: { m: [], k: {} }, r: { m: [], k: {} } });
function loadHist(code) {
  try { return JSON.parse(fs.readFileSync(path.join(HIST, code + '.json'), 'utf8')); } catch { return emptyHist(); }
}
function saveHist(code, h) {
  fs.mkdirSync(HIST, { recursive: true });
  fs.writeFileSync(path.join(HIST, code + '.json'), JSON.stringify(h));
}
function pruneHist(H, fromYm) { // 36개월보다 오래된 달은 버린다
  H.m = H.m.filter((ym) => ym >= fromYm);
  const min = +fromYm * 100;
  for (const k of Object.keys(H.k)) { const l = H.k[k].filter((e) => e[0] >= min); if (l.length) H.k[k] = l; else delete H.k[k]; }
}

// ---------- 거래 카드 데이터 ----------
// 한 시군구의 최근 두 달 거래: v t=매매 j=전세 w=월세, pv/hi/lo/o = [만원, 층, 날짜], s = 처음 수집한 날(고정), sx = 해제를 처음 본 날
const chg = (p, base) => [p - base, ((p - base) / base * 100).toFixed(1)]; // 62800, 61500 → [1300, '2.1']
const pct = (a, b) => Math.round(a / b * 100);
const back6 = (dn) => +new Date(Date.UTC(Math.floor(dn / 10000), (Math.floor(dn / 100) % 100) - 7, dn % 100)).toISOString().slice(0, 10).replace(/-/g, '');
const monthly = (l) => { // 월별 중위값 [yyyymm, 만원]
  const by = {}; for (const e of l || []) (by[Math.floor(e[0] / 100)] ||= []).push(e[1]);
  return Object.keys(by).sort().map((m) => [+m, median(by[m])]);
};
const jeonseMedian = (l, dn) => { // 계약일 전 6개월 전세(갱신 제외) 중위값
  const js = (l || []).filter((e) => e[0] <= dn && e[0] > back6(dn) && e[3] !== 1).map((e) => e[1]);
  return js.length ? [median(js), js.length] : null;
};
const ymdAny = (s) => { s = String(s || '').trim(); return normDate(s) || (/^\d{2}\.\d{2}\.\d{2}$/.test(s) ? '20' + s.replace(/\./g, '-') : ''); };
const dealId = (v, r, key = recKey(r), dn = d8n(r), p = toMan(v === 't' ? r.dealAmount : r.deposit)) => [v, key, dn, p, r.floor, r.monthlyRent, (r.aptDong || '').trim()].join('|');
function dealRows(d, h, months, today, seenOld, seenXOld) {
  const out = [], seen = {}, seenX = {}, spk = {};
  const latest = (l) => (l || []).reduce((a, e) => (!a || e[0] > a[0] ? e : a), null);
  const pfd = (e) => [e[1], e[2], d8s(e[0])];
  const push = (v, r) => {
    const key = recKey(r), dn = d8n(r), x = r.cdealType === 'O', p = toMan(v === 't' ? r.dealAmount : r.deposit);
    const o = { v, key, q: (r.aptSeq || '').trim(), a: r.aptNm, u: r.umdNm, y: +r.buildYear || 0, ar: +r.excluUseAr, f: r.floor, d: d8s(dn), p };
    const id = dealId(v, r, key, dn, p);
    seen[id] = seenOld ? (seenOld[id] ?? today) : ''; // 저장소 첫 실행 날은 기준선('') — 한 번 정한 날짜는 안 바뀐다
    if (seen[id]) o.s = seen[id];
    if (x) { seenX[id] = seenXOld ? (seenXOld[id] ?? today) : ''; if (seenX[id]) o.sx = seenX[id]; o.x = 1; o.cd = ymdAny(r.cdealDay); }
    if (v === 'w') o.m = toMan(r.monthlyRent);
    else {
      const H = v === 't' ? h.t : h.r, st = priorStats(H.k[key], dn), oth = latest((v === 't' ? h.r : h.t).k[key]);
      if (st) { o.pv = pfd(st.prev); o.hi = pfd(st.hi); o.lo = pfd(st.lo); if (!x && p > st.hi[1]) o.r = 1; else if (!x && p === st.hi[1]) o.tie = 1; }
      if (oth) o.o = pfd(oth);
      if (v === 't') { const jr = jeonseMedian(h.r.k[key], dn); if (jr) o.jr = jr; }
      o.sp = spk[v + key] ||= monthly(H.k[key]);
    }
    if (v !== 't') { o.ct = (r.contractType || '').trim(); o.rr = (r.useRRRight || '').trim(); o.pd = toMan(r.preDeposit); o.pm = toMan(r.preMonthlyRent); o.term = (r.contractTerm || '').trim(); }
    else { o.rg = ymdAny(r.rgstDate); o.dg = (r.aptDong || '').trim(); }
    if (r.dealingGbn === '직거래') o.g = 1;
    out.push(o);
  };
  for (const ym of months) {
    for (const r of d.trade[ym] || []) push('t', r);
    for (const r of d.rent[ym] || []) push(toMan(r.monthlyRent) ? 'w' : 'j', r);
  }
  return { deals: out, seen, seenX };
}

// ---------- 렌더: 카드 · 차트 ----------
const ymd2 = (s) => (s ? s.slice(2).replace(/-/g, '.') : '');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const pyeong = (ar) => Math.round(ar * 1.33 / 3.3058); // 전용 → 관습적 공급평형(대략)
const man = (n) => fmtWon(n).replace(/만$/, '');     // 표 안 금액: "6억 2,800"
function sparkSvg(pts) {
  if (!pts || pts.length < 2) return '<span class="spark hint">추이 없음</span>';
  const W = 72, H = 40, ps = pts.map((e) => e[1]), lo = Math.min(...ps), hi = Math.max(...ps);
  const xy = pts.map((e, i) => [2 + i * (W - 4) / (pts.length - 1), H - 3 - (hi === lo ? (H - 6) / 2 : (e[1] - lo) * (H - 6) / (hi - lo))].map((v) => v.toFixed(1)));
  const last = xy[xy.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="월별 중위가 추이 ${pts.length}개월, 최저 ${fmtWon(lo)} 최고 ${fmtWon(hi)}"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${xy.map((p) => p.join(',')).join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.5"/></svg>`;
}
function chartSvg(trade, jeonse) { // 개별 거래 점(매매·전세) + 매매 월 중위선
  const all = [...(trade || []), ...(jeonse || [])];
  if (all.length < 2) return '';
  const W = 640, H = 220, L = 84, B = 22, ds = all.map((e) => Date.parse(d8s(e[0]))), ps = all.map((e) => e[1]);
  const x0 = Math.min(...ds), x1 = Math.max(...ds), y0 = Math.min(...ps) * 0.95, y1 = Math.max(...ps) * 1.05;
  const X = (d) => Math.round(L + (x1 === x0 ? 0.5 : (Date.parse(d8s(d)) - x0) / (x1 - x0)) * (W - L - 8));
  const Y = (p) => Math.round(H - B - (p - y0) / (y1 - y0 || 1) * (H - B - 8));
  const dots = (l, c) => `<path class="${c}" d="${(l || []).map((e) => `M${X(e[0])} ${Y(e[1])}h0`).join('')}"/>`; // 점 = 길이 0 선 + 둥근 끝
  const line = monthly(trade).map(([m, p]) => `${X(m * 100 + 15)},${Y(p)}`).join(' ');
  const ticks = [y0, (y0 + y1) / 2, y1].map((p) => `<text x="${L - 6}" y="${Y(p)}" text-anchor="end" dy="4">${man(Math.round(p / 100) * 100)}</text><line x1="${L}" x2="${W - 8}" y1="${Y(p)}" y2="${Y(p)}" class="grid"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="매매·전세 거래 가격 추이 ${new Date(x0).toISOString().slice(0, 7)}~${new Date(x1).toISOString().slice(0, 7)}">${ticks}
<text x="${L}" y="${H - 5}">${new Date(x0).toISOString().slice(0, 7)}</text><text x="${W - 8}" y="${H - 5}" text-anchor="end">${new Date(x1).toISOString().slice(0, 7)}</text>
${line.includes(' ') ? `<polyline class="med" fill="none" points="${line}"/>` : ''}${dots(jeonse, 'dj')}${dots(trade, 'dt')}</svg>
<p class="hint"><span class="dot dt"></span> 매매 <span class="dot dj"></span> 전세(갱신 포함) · 선 = 매매 월 중위가</p>`;
}
const pfdH = (e) => `${fmtWon(e[0])} (${esc(e[1])}층) <span class="hint">${ymd2(e[2])}</span>`;
const chgH = (p, base) => { const [dd, pc] = chg(p, base); return dd > 0 ? `<span class="up">▲ ${man(dd)} (+${pc}%)</span>` : dd < 0 ? `<span class="down">▼ ${man(-dd)} (${pc}%)</span>` : '<span class="hint">변동 없음</span>'; };
function cardHtml(o, i, reg, yr) {
  const sale = o.v === 't', q = encodeURIComponent(`${reg.name} ${o.u} ${o.a}`), a = Math.round(o.ar);
  const hiI = o.hi && !o.x && o.p > o.hi[0] ? [o.p, o.f, o.d] : o.hi, loI = o.lo && !o.x && o.p < o.lo[0] ? [o.p, o.f, o.d] : o.lo; // 이번 거래 포함 3년 최고·최저
  const c = o.pv && !o.x ? (o.p - o.pv[0]) / o.pv[0] * 100 : '';
  let s = `<li class="deal${o.x ? ' cx' : ''}" data-u="${esc(o.u)}" data-ar="${o.ar}" data-p="${o.p + (o.m || 0) * 100}" data-c="${c === '' ? '' : c.toFixed(2)}" data-d="${o.d}"${o.g ? ' data-g="1"' : ''}>
<div class="dl"><b class="rank">${i + 1}위</b>${o.v === 'w' ? '' : sparkSvg(o.sp)}</div><div class="dm">
<h3>${o.q ? `<a href="/apt/${esc(o.q)}/#a${a}">${esc(o.a)}</a>` : esc(o.a)} <span class="dt">계약 ${ymd2(o.d)}</span></h3>
<p class="hint addr">${esc(reg.name)} ${esc(o.u)}${o.dg ? ' ' + esc(o.dg) + '동' : ''}${o.y ? ` · ${o.y}년 준공 · ${yr - o.y + 1}년차` : ''} · <a href="https://map.naver.com/p/search/${q}" target="_blank" rel="noopener nofollow">네이버지도</a> · <a href="https://map.kakao.com/?q=${q}" target="_blank" rel="noopener nofollow">카카오맵</a></p>
<p class="badges"><span class="b ${o.v}">${sale ? '매매' : o.v === 'j' ? '전세' : '월세'}</span>${o.g ? '<span class="b g">직거래</span>' : ''}${o.r ? '<span class="b fire">🔥 신고가</span>' : ''}${o.tie ? '<span class="b">최고가 동률</span>' : ''}${o.x ? `<span class="b x">해제${o.cd ? ' ' + ymd2(o.cd) : ''}</span>` : ''}${o.rg ? `<span class="b ok">등기 ${ymd2(o.rg)}</span>` : ''}${o.ct ? `<span class="b">${esc(o.ct)}</span>` : ''}${o.s ? ` <span class="hint">계약 후 ${daysBetween(o.d, o.s)}일 만에 공개</span>` : ''}</p>
<p class="price">${o.v === 'w' ? `${fmtWon(o.p)} / 월 ${comma(o.m)}만` : fmtWon(o.p)}${o.pv && !o.x ? ' ' + chgH(o.p, o.pv[0]) : ''}</p>
<ul class="chips sm"><li>${esc(o.f)}층${+o.f <= 2 ? ' · 저층' : ''}</li><li>전용 ${o.ar}㎡ (약 ${pyeong(o.ar)}평형)</li>${o.term ? `<li>기간 ${esc(o.term)}</li>` : ''}</ul>`;
  if (o.v !== 'w') {
    s += '<dl class="kv">';
    s += `<dt>직전거래</dt><dd>${o.pv ? pfdH(o.pv) : '<span class="hint">없음 (3년 내 첫 거래)</span>'}</dd>`;
    if (hiI) s += `<dt>3년 최고</dt><dd>${pfdH(hiI)} · 최고가 대비 <b>${pct(o.p, hiI[0])}%</b></dd><dt>3년 최저</dt><dd>${pfdH(loI)}</dd>`;
    if (sale && o.jr) s += `<dt>전세가율</dt><dd><b>${pct(o.jr[0], o.p)}%</b> · 갭 ${fmtWon(o.p - o.jr[0])} <span class="hint">(전세 중위 ${fmtWon(o.jr[0])}, 최근 6개월 ${o.jr[1]}건)</span></dd>`;
    if (!sale && o.o) s += `<dt>매매 최근</dt><dd>${pfdH(o.o)} · 전세가율 ${pct(o.p, o.o[0])}%</dd>`;
    if (!sale && o.pd && o.ct === '갱신') s += `<dt>종전 보증금</dt><dd>${fmtWon(o.pd)} → ${chgH(o.p, o.pd)}</dd>`;
    s += '</dl>';
  } else if (o.pd || o.pm) s += `<p class="hint">종전 ${fmtWon(o.pd)} / 월 ${comma(o.pm)}만${o.rr ? ' · 갱신요구권 ' + esc(o.rr) : ''}</p>`;
  return s + '</div></li>';
}
const ldScript = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const crumbs = (list) => ({ '@type': 'BreadcrumbList', itemListElement: list.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + p })) });

// /r/{시군구}/ 탭: [경로, 탭 이름, 제목 말, 거르기, 기간(일), 해제 기준]
const RTABS = [
  ['', '매매', '아파트 실거래가', (o) => o.v === 't', 1],
  ['high/', '신고가', '아파트 신고가', (o) => o.v === 't' && o.r, 1],
  ['up/', '상승', '아파트 상승 거래', (o) => o.v === 't' && !o.x && o.pv && o.p > o.pv[0], 1],
  ['down/', '하락', '아파트 하락 거래', (o) => o.v === 't' && !o.x && o.pv && o.p < o.pv[0], 1],
  ['rent/', '전세', '아파트 전세 실거래', (o) => o.v === 'j', 1],
  ['monthly/', '월세', '아파트 월세 실거래', (o) => o.v === 'w', 1],
  ['cancel/', '해제', '아파트 해제 거래', (o) => o.v === 't' && o.x, 1, true],
  ['week/', '최근 7일', '아파트 실거래가 최근 7일', (o) => o.v === 't', 7],
  ['month/', '최근 30일', '아파트 실거래가 최근 30일', (o) => o.v === 't', 30],
];
function scopeOf(o, span, useX, today, baseline) { // 기준선(수집 첫날)엔 계약일로 대신한다
  const s = useX ? o.sx : o.s;
  if (baseline) return useX ? true : daysBetween(o.d, today) < Math.max(span, 30);
  return !!s && daysBetween(s, today) < span;
}
const sortFor = (path) => path === 'up/' ? (a, b) => (b.p - b.pv[0]) - (a.p - a.pv[0]) : path === 'down/' ? (a, b) => (a.p - a.pv[0]) - (b.p - b.pv[0]) : (a, b) => (b.p + (b.m || 0) * 100) - (a.p + (a.m || 0) * 100) || b.d.localeCompare(a.d);
function rTabPage(reg, tab, deals, ctx) {
  const [p, tname, words, pick, span, useX] = tab, { today, baseline, sidoRegs, subsHere, lhHere } = ctx;
  const list = deals.filter((o) => pick(o) && scopeOf(o, span, useX, today, baseline)).sort(sortFor(p));
  const nx = list.filter((o) => o.x).length, nrec = list.filter((o) => o.r).length;
  const mdLabel = `${+today.slice(5, 7)}월 ${+today.slice(8)}일`, sidoShort = reg.sidoShort;
  const scopeText = baseline ? '최근 30일 계약 (공개일 수집을 시작한 날이라 계약일 기준)'
    : span === 1 ? `${today.replace(/-/g, '.')} 새로 공개된 거래(05시 수집)` : `최근 ${span}일 동안 새로 공개된 거래`;
  const title = span === 1 ? `${reg.sido} ${reg.name} ${words} ${mdLabel} ${baseline ? '최근' : '신규'} ${list.length}건` : `${reg.sido} ${reg.name} ${words}`;
  const top = list.find((o) => o.v === 't' && !o.x);
  const base = `/r/${reg.code}/`, url = base + p;
  const desc = `${reg.name} ${scopeText} ${tname} ${list.length}건${nrec ? `, 신고가 ${nrec}건` : ''}.${top ? ` 최고가 ${top.a} ${fmtWon(top.p)}.` : ''} 직전 거래 대비 변동·3년 최고/최저·전세가율 포함.`;
  const yr = +today.slice(0, 4);
  const body = `<p class="hint"><a href="/">홈</a> › <a href="/today/">오늘 실거래가</a> › <a href="/r/${reg.code.slice(0, 2)}/">${esc(reg.sido)}</a> › ${esc(reg.name)}</p>
<h1>${esc(reg.sido)} ${esc(reg.name)} ${words}${span === 1 ? ' ' + mdLabel : ''}</h1>
<nav class="menu" aria-label="보기">${RTABS.map((t) => `<a href="${base}${t[0]}"${t === tab ? ' aria-current="page"' : ''}>${t[1]}</a>`).join('')}</nav>
<p class="sum"><b>${esc(scopeText)}</b> · ${esc(reg.sido)} ${esc(reg.name)} ${tname} (총 ${list.length}건${nx && !useX ? `, 해제 ${nx}건 포함` : ''})</p>
${list.length ? `<div class="card filters" data-js hidden>
<label>읍면동<select id="um"><option value="">전체 읍면동</option>${[...new Set(list.map((o) => o.u))].sort().map((u) => `<option>${esc(u)}</option>`).join('')}</select></label>
<label>면적(전용)<select id="bd"><option value="">전체 면적</option><option value="0-57.99">58㎡ 미만</option><option value="58-60i">59㎡대 (58~60㎡)</option><option value="60-85">60~85㎡</option><option value="83-85i">84㎡대 (83~85㎡)</option><option value="85-135">85~135㎡</option><option value="135-99999">135㎡ 초과</option></select></label>
<label>정렬<select id="so"><option value="">기본(${p === 'up/' || p === 'down/' ? '변동액순' : '금액순'})</option><option value="p">금액순</option><option value="c">상승률순(직전 대비)</option><option value="d">계약일순</option></select></label>
<label class="chk"><input type="checkbox" id="nd"> 직거래 빼기</label><button type="button" id="share">🔗 공유·링크 복사</button></div>
<p class="badges hint"><span class="b t">매매</span><span class="b g">직거래</span><span class="b fire">🔥 신고가</span><span class="b x">해제</span><span class="b ok">등기</span> · 금액 만원 · 면적 전용 · 공개일 = 부동산 알리미가 처음 수집한 날(05시) · 해제 거래는 변동·최고가 계산에서 빼요 · 전세가율 = 최근 6개월 전세(갱신 제외) 중위값 ÷ 매매가</p>
<ol class="deals">${list.map((o, i) => cardHtml(o, i, reg, yr)).join('\n')}</ol>
<button type="button" id="more" class="more" hidden>더 보기</button>`
    : `<p class="card">${span === 1 ? '오늘 새로 공개된 거래가 없습니다' : '해당 기간에 공개된 거래가 없습니다'} · <a href="${base}week/">최근 7일 보기</a> · <a href="/apt/${reg.code}/">최근 두 달 전체 거래표</a></p>`}
${subsHere.length ? `<h2>📝 이 지역 청약</h2><ul class="rec">${subsHere.map((x) => `<li><a href="/subscription/${esc(x.HOUSE_MANAGE_NO)}/">${esc(x.HOUSE_NM)}</a> <span class="hint">접수 ${md(x.RCEPT_BGNDE)}~${md(x.RCEPT_ENDDE)}</span></li>`).join('')}</ul>` : ''}
${lhHere.length ? `<h2>🏠 ${esc(reg.sido)} LH 공고</h2><ul class="rec">${lhHere.map((x) => `<li>${link(x.DTL_URL, esc(x.PAN_NM))} <span class="hint">마감 ${md(x.CLSG_DT)}</span></li>`).join('')}</ul>` : ''}
<h2>${esc(reg.sido)} 다른 시·군·구</h2><ul class="chips">${sidoRegs.map((r) => `<li><a href="/r/${r.code}/${p}"${r.code === reg.code ? ' aria-current="page"' : ''}>${esc(r.name)}</a></li>`).join('')}</ul>
<p class="hint">신고가 = 같은 단지·같은 전용면적(㎡ 반올림)에서 계약일이 더 이른 거래(최대 3년)의 최고가보다 비싼 거래(같은 값은 '최고가 동률'). 3년 최고·최저는 이번 거래를 포함해요. “계약 후 N일 만에 공개”는 처음 수집한 날로 고정돼요.</p>
<script src="/today.js" defer></script>`;
  const ld = [crumbs([['홈', '/'], ['오늘 실거래가', '/today/'], [reg.sido, `/r/${reg.code.slice(0, 2)}/`], [reg.name, base]]),
    { '@type': 'ItemList', name: title, numberOfItems: list.length, itemListElement: list.slice(0, 30).map((o, i) => ({ '@type': 'ListItem', position: i + 1, name: `${o.a} ${o.ar}㎡ ${fmtWon(o.p)}`, ...(o.q ? { url: `${SITE}/apt/${o.q}/` } : {}) })) }];
  return { n: list.length, nrec, html: page({ price: top?.p, title: `${title} | 부동산 알리미`, p: url, desc, body, noindex: !list.length, ld: { '@context': 'https://schema.org', '@graph': ld } }) };
}

// /apt/{aptSeq}/ 단지 상세: 면적별 요약·차트·이력 (저장소 36개월 + 최근 두 달 원자료)
function aptPage(seq, reg, keysOf, h, rowsT, rowsR, neighbors, subsHere, today) {
  const meta = [...rowsT, ...rowsR].sort((a, b) => dealDate(b).localeCompare(dealDate(a)))[0];
  const nm = meta.aptNm, umd = meta.umdNm, by = +meta.buildYear || 0, road = (meta.roadNm || meta.roadnm || '').trim(), yr = +today.slice(0, 4);
  const areas = [...new Set(keysOf.map((k) => +k.split('|')[1]))].sort((a, b) => a - b);
  const realAr = {}; for (const r of [...rowsT, ...rowsR]) realAr[Math.round(+r.excluUseAr)] ||= +r.excluUseAr; // 표시는 실제 전용면적
  const arTxt = (a) => realAr[a] || a;
  const dn = +today.replace(/-/g, '');
  const winT = {}; for (const r of rowsT) (winT[`${d8n(r)}|${toMan(r.dealAmount)}|${parseInt(r.floor, 10) || 0}`] ||= r);
  let latestAll = null, jrAll = null;
  const secs = areas.map((a) => {
    const key = `${seq}|${a}`, T = (h.t.k[key] || []).slice().sort((x, y) => y[0] - x[0]), J = (h.r.k[key] || []).slice().sort((x, y) => y[0] - x[0]);
    const cx = rowsT.filter((r) => r.cdealType === 'O' && recKey(r) === key);
    const last = T[0], hi = T.reduce((m, e) => (!m || e[1] > m[1] ? e : m), null), lo = T.reduce((m, e) => (!m || e[1] < m[1] ? e : m), null);
    const jr = jeonseMedian(h.r.k[key], dn), n12 = T.filter((e) => e[0] > dn - 10000).length;
    if (last && (!latestAll || last[0] > latestAll[0][0])) latestAll = [last, arTxt(a)];
    if (jr && last && !jrAll) jrAll = pct(jr[0], last[1]);
    const kv = [
      last && ['최근 매매', `<b>${fmtWon(last[1])}</b> (${last[2]}층) <span class="hint">${ymd2(d8s(last[0]))}</span>`],
      hi && ['3년 최고', `${fmtWon(hi[1])} (${hi[2]}층) <span class="hint">${ymd2(d8s(hi[0]))}</span>${last ? ` · 최고가 대비 <b>${pct(last[1], hi[1])}%</b>` : ''}`],
      lo && ['3년 최저', `${fmtWon(lo[1])} (${lo[2]}층) <span class="hint">${ymd2(d8s(lo[0]))}</span>`],
      jr && ['전세 중위', `${fmtWon(jr[0])} <span class="hint">(최근 6개월 갱신 제외 ${jr[1]}건)</span>${last ? ` · 전세가율 <b>${pct(jr[0], last[1])}%</b> · 갭 ${fmtWon(last[1] - jr[0])}` : ''}`],
      ['최근 12개월 매매', `${n12}건`],
    ].filter(Boolean);
    const tRows = [...T.slice(0, 15).map((e) => { const w = winT[`${e[0]}|${e[1]}|${e[2]}`]; return [e[0], `<tr>${td(ymd2(d8s(e[0])))}${td(fmtWon(e[1]), 1)}${td(e[2], 1)}${td(w ? [w.aptDong?.trim() ? esc(w.aptDong.trim()) + '동' : '', w.dealingGbn === '직거래' ? '직거래' : '', ymdAny(w.rgstDate) ? '등기 ' + ymd2(ymdAny(w.rgstDate)) : ''].filter(Boolean).join(' · ') : '')}</tr>`]; }),
      ...cx.map((r) => [d8n(r), `<tr class="cx">${td(`<s>${ymd2(dealDate(r))}</s>`)}${td(`<s>${fmtWon(toMan(r.dealAmount))}</s>`, 1)}${td(esc(r.floor), 1)}${td(`해제 ${ymd2(ymdAny(r.cdealDay))}`)}</tr>`])].sort((x, y) => y[0] - x[0]).map((x) => x[1]);
    const rr = rowsR.filter((r) => recKey(r) === key).sort((x, y) => dealDate(y).localeCompare(dealDate(x)));
    return `<section id="a${a}"><h2>전용 ${arTxt(a)}㎡ <span class="hint">(약 ${pyeong(a)}평형)</span></h2>
<dl class="kv card">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
${chartSvg(T.slice(0, 150), J.slice(0, 100))}
<h3>매매 이력 (최근 3년 ${T.length}건${T.length > 15 ? ', 최근 15건 표시' : ''})</h3>${table(['계약일', '거래가 ', '층 ', '비고'], tRows)}
${J.length ? `<h3>전세 이력 (최근 3년 ${J.length}건${J.length > 8 ? ', 최근 8건 표시' : ''})</h3>${table(['계약일', '보증금 ', '층 ', '구분'], J.slice(0, 8).map((e) => `<tr>${td(ymd2(d8s(e[0])))}${td(fmtWon(e[1]), 1)}${td(e[2], 1)}${td(e[3] === 1 ? '갱신' : '')}</tr>`))}` : ''}
${rr.length ? `<h3>최근 두 달 전월세 (${rr.length}건${rr.length > 10 ? ', 최근 10건 표시' : ''})</h3>${table(['계약일', '보증금 ', '월세 ', '층 ', '구분', '종전→이번', '기간'], rr.slice(0, 10).map((r) => { const pd = toMan(r.preDeposit), dp = toMan(r.deposit); return `<tr>${td(ymd2(dealDate(r)))}${td(fmtWon(dp), 1)}${td(toMan(r.monthlyRent) ? comma(toMan(r.monthlyRent)) + '만' : '-', 1)}${td(esc(r.floor), 1)}${td(esc([r.contractType, (r.useRRRight || '').trim() === '사용' ? '갱신요구권' : ''].filter((v) => v && v.trim()).join(' · ')))}${td(pd ? `${man(pd)}→${man(dp)} (${chg(dp, pd)[1]}%)` : '')}${td(esc(r.contractTerm || ''))}</tr>`; }))}` : ''}
</section>`;
  });
  const base = `/apt/${seq}/`, lastTxt = latestAll ? `${fmtWon(latestAll[0][1])} (${latestAll[1]}㎡, ${ymd2(d8s(latestAll[0][0])).slice(0, 5)})` : '';
  const nT = keysOf.reduce((s, k) => s + (h.t.k[k] || []).length, 0), nJ = keysOf.reduce((s, k) => s + (h.r.k[k] || []).length, 0);
  const body = `<p class="hint"><a href="/">홈</a> › <a href="/r/${reg.code.slice(0, 2)}/">${esc(reg.sido)}</a> › <a href="/r/${reg.code}/">${esc(reg.name)}</a> › ${esc(umd)}</p>
<h1>${esc(reg.name)} ${esc(umd)} ${esc(nm)} 실거래가</h1>
<p class="lead">${esc(reg.sido)} ${esc(reg.name)} ${esc(umd)} ${esc(meta.jibun || '')}${road ? ' · ' + esc(road) : ''}${by ? ` · ${by}년 준공 · ${yr - by + 1}년차` : ''}</p>
<ul class="chips">${areas.map((a) => `<li><a href="#a${a}">전용 ${arTxt(a)}㎡</a></li>`).join('')}<li><a href="https://map.naver.com/p/search/${encodeURIComponent(`${reg.name} ${umd} ${nm}`)}" target="_blank" rel="noopener nofollow">네이버지도</a></li></ul>
${secs.join('\n')}
${neighbors.length ? `<h2>${esc(umd)} 다른 단지</h2><ul class="chips">${neighbors.map(([q, n]) => `<li><a href="/apt/${esc(q)}/">${esc(n)}</a></li>`).join('')}</ul>` : ''}
${subsHere.length ? `<h2>📝 ${esc(reg.name)} 청약</h2><ul class="rec">${subsHere.map((x) => `<li><a href="/subscription/${esc(x.HOUSE_MANAGE_NO)}/">${esc(x.HOUSE_NM)}</a> <span class="hint">접수 ${md(x.RCEPT_BGNDE)}~${md(x.RCEPT_ENDDE)}</span></li>`).join('')}</ul>` : ''}
<p class="hint">금액은 신고가 기준 계약 금액이에요. 면적은 전용면적을 ㎡ 단위로 반올림해 묶었어요. <a href="/r/${reg.code}/">${esc(reg.name)} 오늘 실거래가 →</a></p>`;
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'ApartmentComplex', name: nm, url: SITE + base, address: { '@type': 'PostalAddress', addressRegion: reg.sido, addressLocality: `${reg.name} ${umd}`, ...(road ? { streetAddress: road } : {}), addressCountry: 'KR' }, ...(by ? { additionalProperty: { '@type': 'PropertyValue', name: 'yearBuilt', value: by } } : {}) },
    crumbs([['홈', '/'], [reg.sido, `/r/${reg.code.slice(0, 2)}/`], [reg.name, `/r/${reg.code}/`], [nm, base]])] };
  const n = nT + nJ; // 최근 3년 매매+전세 건수: 5건 미만은 얇은 페이지라 noindex(사이트맵 제외), 주소는 그대로 연다
  return { n, noindex: n < APT_MIN, html: page({ price: latestAll?.[0][1], noindex: n < APT_MIN, title: `${nm} 실거래가 ${lastTxt}${jrAll ? ` · 전세가율 ${jrAll}%` : ''} | ${reg.name} ${umd}`, p: base, body, ld,
    desc: `${nm}(${by ? by + '년, ' : ''}${reg.name} ${umd}) 최근 3년 매매 ${nT}건·전세 ${nJ}건 이력, 면적별 3년 최고·최저, 최근 전세 중위값과 전세가율.` }) };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- 렌더 ----------
let STAMP = '';
const INDEXNOW_KEY = 'e386846d4b6f939fd1b440af9728c599';
const NETWORK = [['계산기', CALC], ['부동산 알리미', SITE], ['정부 지원금 찾기', 'https://grant.hanbogi.com'], ['여행회화', 'https://talk.hanbogi.com'], ['혜택 알리미', 'https://benefit.hanbogi.com'], ['자격증 한눈에', 'https://license.hanbogi.com'], ['오늘의 게임', 'https://hanbogi.com'], ['오늘의 숙소', 'https://stay.hanbogi.com'], ['기기 비교소', 'https://gadget.hanbogi.com']];
// 혜택 알리미 청약 가점 글(/9)은 2026-10-01 12:00 예약 공개 — 그 전엔 블로그 홈으로
const benefitSub = (today) => today >= '2026-10-02' ? 'https://benefit.hanbogi.com/9' : 'https://benefit.hanbogi.com';
function page({ title, desc, p, body, noindex, ld, price }) { // price(만원) = 계산기에 미리 채울 거래가
  const pq = price ? ` <span class="hint">(${fmtWon(price)} 기준)</span>` : '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${p}">${noindex ? '\n<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${p}">
<meta property="og:type" content="website"><meta property="og:site_name" content="부동산 알리미"><meta property="og:locale" content="ko_KR">
<meta property="og:image" content="${SITE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="부동산 알리미 실거래 리포트" href="${SITE}/rss.xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">${ld ? '\n' + ldScript(ld) : ''}
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5424435978828190" crossorigin="anonymous"></script>
<meta name="naver-site-verification" content="fa471c31c15624eed79795f1054ec33c0ea276b2" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-19F8RF6971"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-19F8RF6971");</script>
</head>
<body>
<header><a href="/">부동산 알리미</a></header>
<main>
${body}
<p class="warn">⚠️ 참고용 정보예요. 실거래가는 <b>신고 기준</b>이라 계약 해제·정정 신고로 나중에 바뀌거나 빠질 수 있어요. 청약·LH 공고는 일정이 바뀔 수 있으니 반드시 원문 공고문을 확인하세요.</p>
<div class="card"><b>🧮 함께 쓰는 계산기</b>
<ul class="chips" style="margin:10px 0 0"><li><a href="${CALC}/subscription/">청약 가점 계산기</a></li><li><a href="${CALC}/acquisition-tax/${price ? '?price=' + price : ''}">취득세 계산기${pq}</a></li><li><a href="${CALC}/brokerage/${price ? '?deal=sale&amp;amt=' + price : ''}">중개수수료 계산기${pq}</a></li><li><a href="${CALC}/loan/${price ? "?amt=" + Math.round(price * 0.7 / 100) * 100 : ""}">주택담보대출 계산기${price ? " (집값 70% 대출 예시)" : ""}</a></li><li><a href="${CALC}/rent/">전월세 전환 계산기</a></li></ul></div>
</main>
<footer>데이터 출처: 국토교통부/한국부동산원/LH (공공데이터포털), 기준 시각 ${STAMP} KST<br>
© 부동산 알리미 · <a href="/">홈</a> · <a href="/subscription/">청약 일정</a> · <a href="/lh/">LH 공고</a> · <a href="/about.html">소개</a> · <a href="/privacy.html">개인정보처리방침</a> · <a href="/rss.xml">RSS</a><br>
한보기 네트워크: ${NETWORK.map(([n, u]) => `<a href="${u}/">${n}</a>`).join(' · ')}</footer>
</body></html>
`;
}
const table = (head, rows) => rows.length
  ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th${h.endsWith(' ') ? ' class="n"' : ''}>${h.trim()}</th>`).join('')}</tr></thead><tbody>\n${rows.join('\n')}\n</tbody></table></div>`
  : '<p class="hint">해당 자료가 없어요.</p>';
const td = (v, num) => `<td${num ? ' class="n"' : ''}>${v}</td>`;
const ymLabel = (ym) => `${+ym.slice(0, 4)}년 ${+ym.slice(4)}월`;
const md = (d) => { const n = normDate(d); return n ? `${+n.slice(5, 7)}.${+n.slice(8)}` : '-'; };
const dealDate = (r) => `${r.dealYear}-${String(r.dealMonth).padStart(2, '0')}-${String(r.dealDay).padStart(2, '0')}`;
const byDateDesc = (a, b) => dealDate(b).localeCompare(dealDate(a));
const link = (url, text) => /^https?:\/\//.test(url || '') ? `<a href="${esc(url.trim())}" rel="nofollow noopener" target="_blank">${text}</a>` : text;

function bandTable(months, get, cols) { // months: [[ym, rows]]
  const head = ['면적대', ...months.flatMap(([ym]) => cols.map((c) => `${ymLabel(ym).slice(6)} ${c} `))];
  const rows = BANDS.map((b) => '<tr>' + td(b) + months.map(([, rows]) => get(rows.filter((r) => areaBand(+r.excluUseAr) === b))).join('') + '</tr>');
  return table(head, rows);
}

function recBox(d) { // 시군구 페이지의 '이 지역 신고가' 상자
  const part = (kind, name) => {
    const list = d.rec[kind].slice(0, 10);
    const note = d.cov[kind] < RELIABLE ? ` <span class="hint">과거 데이터 수집 중(최근 ${d.cov[kind]}개월 기준)</span>` : '';
    return `<p style="margin:10px 0 4px"><b>${name}</b> <span class="hint">최근 두 달 ${d.rec[kind].length}건</span>${note}</p>` + (list.length
      ? '<ul class="rec">' + list.map((x) => `<li>${md(x.d)} ${esc(x.r.aptNm)} ${Math.round(+x.r.excluUseAr)}㎡ ${esc(x.r.floor)}층 <b>${fmtWon(x.p)}</b> <span class="up">▲${fmtWon(x.p - x.prev)}</span> <span class="hint">이전 ${fmtWon(x.prev)}(${esc(x.prevDate)})</span></li>`).join('') + '</ul>'
      : '<p class="hint" style="margin:0">해당 거래가 없어요.</p>');
  };
  return `<div class="card"><b>🔥 이 지역 신고가</b> <a class="hint" href="/r/${d.code}/high/">오늘 실거래가에서 자세히 →</a>${part('t', '매매')}${part('r', '전세')}<p class="hint" style="margin:8px 0 0">같은 단지·같은 전용면적(㎡ 반올림)에서 계약일이 더 이른 거래의 최고가를 넘은 거래예요.</p></div>`;
}

function regionPage(reg, label, months, trade, rent, failed, d) {
  const sidoCode = reg.code.slice(0, 2);
  const [cur] = months;
  const liveT = (ym) => (trade[ym] || []).filter((r) => r.cdealType !== 'O');
  const nT = months.reduce((s, ym) => s + liveT(ym).length, 0);
  const nR = months.reduce((s, ym) => s + (rent[ym] || []).length, 0);
  const title = `${label} 아파트 실거래가 ${ymLabel(cur)} | 최근 신고 거래`;
  let body = `<p class="hint"><a href="/">홈</a> › <a href="/apt/${sidoCode}/">${esc(reg.sido)}</a> › ${esc(reg.name)}</p>
<h1>${esc(label)} 아파트 실거래가 ${ymLabel(cur)}</h1>
<p class="lead">${esc(reg.sido)} ${esc(reg.name)}에서 최근 두 달(${months.map(ymLabel).join('·')}) 신고된 아파트 매매 <b>${nT}건</b>, 전월세 <b>${nR}건</b>이에요. 매일 새벽 국토교통부 자료로 갱신돼요.</p>`;
  if (failed) body += '<p class="warn">이번 갱신에서 일부 자료를 불러오지 못했어요. 내일 다시 갱신돼요.</p>';
  body += `<p><a class="cta" href="/r/${reg.code}/">📋 ${esc(label)} 오늘 공개된 실거래 · 신고가·상승·하락 보기 →</a></p>`;
  if (d?.rec) body += recBox(d);

  const tm = months.map((ym) => [ym, liveT(ym)]);
  body += `<h2>면적대별 매매 중위가격</h2>` + bandTable(tm, (rs) => td(rs.length, 1) + td(rs.length ? fmtWon(median(rs.map((r) => toMan(r.dealAmount)))) : '-', 1), ['건수', '중위가격']);
  for (const ym of months) {
    const rows = liveT(ym).sort(byDateDesc);
    const cancelled = (trade[ym] || []).length - rows.length;
    body += `<h2>${ymLabel(ym)} 매매 거래 (${rows.length}건)</h2>`;
    if (cancelled) body += `<p class="hint">계약 해제 신고 ${cancelled}건은 뺐어요.</p>`;
    if (rows.length > ROW_LIMIT) body += `<p class="hint">최근 계약 ${ROW_LIMIT}건만 보여줘요.</p>`;
    body += table(['계약일', '단지', '전용㎡ ', '층 ', '거래금액 ', '동'], rows.slice(0, ROW_LIMIT).map((r) => '<tr>' +
      td(md(dealDate(r))) + td(esc(r.aptNm)) + td(esc(r.excluUseAr), 1) + td(esc(r.floor), 1) + td(`<b>${fmtWon(toMan(r.dealAmount))}</b>`, 1) + td(esc(r.umdNm)) + '</tr>'));
  }

  const rm = months.map((ym) => [ym, rent[ym] || []]);
  body += `<h2>면적대별 전세 보증금 중위값</h2>` + bandTable(rm, (rs) => {
    const j = rs.filter((r) => !toMan(r.monthlyRent));
    return td(j.length, 1) + td(j.length ? fmtWon(median(j.map((r) => toMan(r.deposit)))) : '-', 1) + td(rs.length - j.length, 1);
  }, ['전세', '전세 중위', '월세']);
  body += `<p class="hint">전세·월세 전환율이 궁금하면 <a href="${CALC}/rent/">전월세 전환 계산기</a>로 계산해 보세요.</p>`;
  for (const ym of months) {
    const rows = (rent[ym] || []).sort(byDateDesc);
    body += `<h2>${ymLabel(ym)} 전월세 거래 (${rows.length}건)</h2>`;
    if (rows.length > ROW_LIMIT) body += `<p class="hint">최근 계약 ${ROW_LIMIT}건만 보여줘요.</p>`;
    body += table(['계약일', '단지', '전용㎡ ', '층 ', '보증금 ', '월세 ', '구분', '동'], rows.slice(0, ROW_LIMIT).map((r) => '<tr>' +
      td(md(dealDate(r))) + td(esc(r.aptNm)) + td(esc(r.excluUseAr), 1) + td(esc(r.floor), 1) + td(fmtWon(toMan(r.deposit)), 1) +
      td(toMan(r.monthlyRent) ? comma(toMan(r.monthlyRent)) + '만' : '-', 1) + td(esc(r.contractType || '-')) + td(esc(r.umdNm)) + '</tr>'));
  }
  return {
    nT, nR, noindex: nT + nR === 0 || failed,
    html: page({ price: median(months.flatMap((ym) => liveT(ym).map((r) => toMan(r.dealAmount)))), title: title + ' | 부동산 알리미', p: `/apt/${reg.code}/`, body, noindex: nT + nR === 0 || failed,
      desc: `${reg.sido} ${reg.name} 아파트 매매 실거래가 ${nT}건과 전월세 ${nR}건. 단지·면적·층·거래금액과 면적대별 중위가격을 매일 갱신해요.` }),
  };
}

function subRow(x) {
  return '<tr>' + td(esc(x.SUBSCRPT_AREA_CODE_NM)) + td(`<a href="/subscription/${esc(x.HOUSE_MANAGE_NO)}/">${esc(x.HOUSE_NM)}</a>`) +
    td(x.TOT_SUPLY_HSHLDCO ? comma(x.TOT_SUPLY_HSHLDCO) + '세대' : '-', 1) + td(`${md(x.RCEPT_BGNDE)}~${md(x.RCEPT_ENDDE)}`) + td(md(x.PRZWNER_PRESNATN_DE)) +
    td(link(x.PBLANC_URL, '청약홈')) + '</tr>';
}
const SUB_HEAD = ['지역', '단지명', '공급 ', '청약접수', '당첨발표', '원문'];

function subDetail(x, models, today) {
  const sched = [
    ['모집공고일', normDate(x.RCRIT_PBLANC_DE)],
    ['특별공급 접수', [x.SPSPLY_RCEPT_BGNDE, x.SPSPLY_RCEPT_ENDDE]],
    ['1순위 해당지역', [x.GNRL_RNK1_CRSPAREA_RCPTDE, x.GNRL_RNK1_CRSPAREA_ENDDE]],
    ['1순위 경기지역', [x.GNRL_RNK1_ETC_GG_RCPTDE, x.GNRL_RNK1_ETC_GG_ENDDE]],
    ['1순위 기타지역', [x.GNRL_RNK1_ETC_AREA_RCPTDE, x.GNRL_RNK1_ETC_AREA_ENDDE]],
    ['2순위 해당지역', [x.GNRL_RNK2_CRSPAREA_RCPTDE, x.GNRL_RNK2_CRSPAREA_ENDDE]],
    ['2순위 기타지역', [x.GNRL_RNK2_ETC_AREA_RCPTDE, x.GNRL_RNK2_ETC_AREA_ENDDE]],
    ['당첨자 발표', normDate(x.PRZWNER_PRESNATN_DE)],
    ['계약', [x.CNTRCT_CNCLS_BGNDE, x.CNTRCT_CNCLS_ENDDE]],
  ].map(([k, v]) => [k, Array.isArray(v) ? [...new Set(v.map(normDate).filter(Boolean))].join(' ~ ') : v]).filter(([, v]) => v);
  const yn = (v) => (v === 'Y' ? '해당' : '');
  const info = [
    ['공급위치', x.HSSPLY_ADRES], ['주택 구분', [x.HOUSE_SECD_NM, x.HOUSE_DTL_SECD_NM, x.RENT_SECD_NM].filter(Boolean).join(' · ')],
    ['공급규모', x.TOT_SUPLY_HSHLDCO ? comma(x.TOT_SUPLY_HSHLDCO) + '세대' : ''], ['시공사', x.CNSTRCT_ENTRPS_NM], ['시행사', x.BSNS_MBY_NM],
    ['입주예정', x.MVN_PREARNGE_YM ? `${x.MVN_PREARNGE_YM.slice(0, 4)}년 ${+x.MVN_PREARNGE_YM.slice(4)}월` : ''], ['문의처', x.MDHS_TELNO],
    ['투기과열지구', yn(x.SPECLT_RDN_EARTH_AT)], ['조정대상지역', yn(x.MDAT_TRGET_AREA_SECD)], ['분양가상한제', yn(x.PARCPRC_ULS_AT)],
  ].filter(([, v]) => v);
  const kv = (rows) => table(['항목', '내용'], rows.map(([k, v]) => '<tr>' + td(k) + td(esc(v)) + '</tr>'));
  const n = (v) => comma(+v || 0);
  const body = `<p class="hint"><a href="/">홈</a> › <a href="/subscription/">청약 일정</a> › ${esc(x.SUBSCRPT_AREA_CODE_NM)}</p>
<h1>${esc(x.HOUSE_NM)} 청약 일정·분양가</h1>
<p class="lead">${esc(x.HSSPLY_ADRES)} · 청약접수 ${esc(normDate(x.RCEPT_BGNDE))} ~ ${esc(normDate(x.RCEPT_ENDDE))} · 당첨발표 ${esc(normDate(x.PRZWNER_PRESNATN_DE) || '-')}</p>
<p>${link(x.PBLANC_URL, '👉 청약홈 모집공고 원문 보기')}${x.HMPG_ADRES ? ' · ' + link(/^https?:/.test(x.HMPG_ADRES) ? x.HMPG_ADRES : 'http://' + x.HMPG_ADRES, '분양 홈페이지') : ''}</p>
<h2>청약 일정</h2>${kv(sched)}
<h2>주택형별 공급·분양가</h2>${models ? table(['주택형', '공급면적㎡ ', '일반공급 ', '특별공급 ', '분양최고가 '], models.map((m) => '<tr>' +
    td(esc(m.HOUSE_TY)) + td(esc(m.SUPLY_AR), 1) + td(n(m.SUPLY_HSHLDCO), 1) + td(n(m.SPSPLY_HSHLDCO), 1) + td(toMan(m.LTTOT_TOP_AMOUNT) ? fmtWon(toMan(m.LTTOT_TOP_AMOUNT)) : '-', 1) + '</tr>'))
    : '<p class="hint">주택형 정보를 불러오지 못했어요. 원문 공고를 확인하세요.</p>'}
<h2>단지 정보</h2>${kv(info)}
<p>내 청약 가점이 궁금하면 <a href="${CALC}/subscription/">청약 가점 계산기</a>, 가점 계산법은 <a href="${benefitSub(today)}">혜택 알리미 청약 가점 정리</a>, 분양가 기준 세금은 <a href="${CALC}/acquisition-tax/">취득세 계산기</a>로 확인하세요.</p>`;
  return page({ title: `${x.HOUSE_NM} 청약 일정·분양가 | 부동산 알리미`, p: `/subscription/${x.HOUSE_MANAGE_NO}/`, body,
    desc: `${x.HOUSE_NM} (${x.SUBSCRPT_AREA_CODE_NM}) 청약 접수 ${normDate(x.RCEPT_BGNDE)}~${normDate(x.RCEPT_ENDDE)}, 당첨자 발표 ${normDate(x.PRZWNER_PRESNATN_DE)}. 주택형별 공급세대와 분양가.` });
}

// 홈 '최근 신고가' 카드. REC 줄 = [시도, 지역, 시군구, 단지, 전용, 층, 만원, 이전 최고, 이전 최고일, 계약일, aptSeq, 동, 준공, 직거래, 월별 중위가[], 처음 본 날(없으면 '')]
// 정렬·카드 함수는 브라우저에도 그대로(String(fn)) 실어 보낸다 — 테스트한 코드와 화면 코드가 같다
const REC_SORT = {
  rate: (a, b) => b[6] / b[7] - a[6] / a[7] || b[9].localeCompare(a[9]), // 상승률(이전 최고 대비) 높은 순, 같으면 최신 계약
  amt: (a, b) => (b[6] - b[7]) - (a[6] - a[7]) || b[9].localeCompare(a[9]),
  new: (a, b) => b[9].localeCompare(a[9]) || b[6] / b[7] - a[6] / a[7],
};
const recFilter = (L, sd, sg) => L.filter((x) => (!sd || x[0] === sd) && (!sg || x[2] === sg)); // 시도·시군구 ('' = 전체)
function sggOpts(D, k, sd) { // 시군구 선택지 [코드, 이름, 현재 탭 건수] — 두 탭 모두의 시군구를 이름순으로
  const m = {};
  for (const x of D.t.concat(D.r)) if (x[0] === sd) m[x[2]] ||= [x[2], x[1].split(' ').slice(1).join(' '), 0];
  for (const x of D[k]) if (m[x[2]]) m[x[2]][2]++;
  return Object.values(m).sort((a, b) => a[1].localeCompare(b[1], 'ko'));
}
function recCard(x, i, k, yr) {
  const [, rn, code, a, ar, f, p, prev, pd, d, q, u, by, g, sp, s] = x, lag = s && d ? Math.round((Date.parse(s) - Date.parse(d)) / 864e5) : -1;
  return `<li class="deal"><div class="dl"><b class="rank">${i + 1}위</b>${sparkSvg(sp.map((v, j) => [j, v]))}</div><div class="dm">
<h3>${q ? `<a href="/apt/${esc(q)}/#a${Math.round(ar)}">${esc(a)}</a>` : esc(a)} <span class="dt">계약 ${ymd2(d)}</span></h3>
<p class="hint addr"><a href="/r/${code}/high/">${esc(rn)}</a> ${esc(u)}${by ? ` · ${by}년 준공 · ${yr - by + 1}년차` : ''}</p>
<p class="badges"><span class="b ${k === 't' ? 't">매매' : 'j">전세'}</span><span class="b fire">🔥 신고가</span>${g ? '<span class="b g">직거래</span>' : ''}</p>
<p class="price">${fmtWon(p)} ${chgH(p, prev)}</p>
${lag >= 0 ? `<p class="hint">공개 ${ymd2(s)} · ${lag ? `계약 후 ${lag}일 만에 공개` : '계약 당일 공개'}</p>
` : ''}<ul class="chips sm"><li>${esc(f)}층</li><li>전용 ${ar}㎡ (약 ${pyeong(ar)}평형)</li></ul>
<dl class="kv"><dt>이전 최고가</dt><dd>${fmtWon(prev)} <span class="hint">· ${ymd2(pd)} 계약</span></dd></dl></div></li>`;
}
function recSection(recs, collecting, sidos, yr) { // 자료는 /data/rec.json (빌드 때 생성), 카드는 20장씩 그린다
  const note = (k) => collecting[k].length ? `과거 데이터 수집 중(최근 ${collecting[k].minCov}개월 기준)인 ${collecting[k].length}곳은 빠져 있어요.` : '';
  const json = JSON.stringify({ t: recs.t.slice(0, 3000), r: recs.r.slice(0, 3000), note: { t: note('t'), r: note('r') } });
  const fns = { comma, esc, fmtWon, man, chg, chgH, pyeong, ymd2, sparkSvg, recFilter, sggOpts, recCard };
  const js = `(function(){${Object.entries(fns).map(([n, f]) => `var ${n}=${f};`).join('')}var SORT={${Object.entries(REC_SORT).map(([n, f]) => `${n}:${f}`).join(',')}};
var D,k="t",n=20,Y=${yr},$=function(i){return document.getElementById(i)},tabs=document.querySelectorAll("#rec-tabs [data-k]"),Q=new URLSearchParams(location.search),sg0=Q.get("sgg")||"";
function pick(el,v){if(v&&[].some.call(el.options,function(o){return o.value===v}))el.value=v}
pick($("rec-sido"),Q.get("sido"));pick($("rec-so"),Q.get("sort"));if(Q.get("type")==="전세")k="r";
[].forEach.call(tabs,function(x){x.setAttribute("aria-selected",x.dataset.k===k)});
function fillSgg(){var sd=$("rec-sido").value,el=$("rec-sgg"),v=sg0||el.value;sg0="";el.innerHTML='<option value="">시·군·구 전체</option>'+(sd&&D?sggOpts(D,k,sd).map(function(o){return'<option value="'+o[0]+'">'+esc(o[1])+" ("+o[2]+")</option>"}).join(""):"");el.disabled=!sd||!D;pick(el,v);if(el.value!==v)el.value=""}
function sync(){var p=new URLSearchParams(),a=[["sido",$("rec-sido").value],["sgg",$("rec-sgg").value],["type",k==="r"?"전세":""],["sort",$("rec-so").value==="rate"?"":$("rec-so").value]];a.forEach(function(e){if(e[1])p.set(e[0],e[1])});p=p.toString();try{history.replaceState(null,"",location.pathname+(p?"?"+p:"")+location.hash)}catch(e){}}
function draw(){if(!D)return;sync();var L=recFilter(D[k],$("rec-sido").value,$("rec-sgg").value).sort(SORT[$("rec-so").value]);
$("rec-note").textContent=D.note[k];$("rec-list").innerHTML=L.slice(0,n).map(function(x,i){return recCard(x,i,k,Y)}).join("");
$("rec-empty").hidden=L.length>0;$("rec-more").hidden=L.length<=n}
function reset(){n=20;draw()}
[].forEach.call(tabs,function(b){b.onclick=function(){k=b.dataset.k;[].forEach.call(tabs,function(x){x.setAttribute("aria-selected",x===b)});fillSgg();reset()}});
$("rec-sido").onchange=function(){$("rec-sgg").value="";fillSgg();reset()};$("rec-sgg").onchange=$("rec-so").onchange=reset;$("rec-more").onclick=function(){n+=20;draw()};
fetch("/data/rec.json").then(function(r){return r.json()}).then(function(j){D=j;fillSgg();draw()}).catch(function(){$("rec-note").textContent="신고가 자료를 불러오지 못했어요."})})();`;
  return { json, html: `<h2>🔥 최근 신고가</h2>
<p class="hint">최근 14일 계약 중 같은 단지·같은 전용면적(㎡ 반올림)에서 그 전 최고가를 넘은 거래예요. 매매는 해제 거래, 전세는 월세를 뺐어요. 그래프 = 월별 중위가 추이(최대 3년).</p>
<div class="tabs" id="rec-tabs" role="tablist"><button type="button" role="tab" data-k="t" aria-selected="true">매매 <span class="c">${comma(recs.t.length)}</span></button><button type="button" role="tab" data-k="r" aria-selected="false">전세 <span class="c">${comma(recs.r.length)}</span></button>
<select id="rec-sido" aria-label="시도 선택"><option value="">전국 전체</option>${sidos.map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
<select id="rec-sgg" aria-label="시군구 선택" disabled><option value="">시·군·구 전체</option></select>
<select id="rec-so" aria-label="정렬"><option value="rate">상승률순</option><option value="amt">상승액순</option><option value="new">최신 계약순</option></select></div>
<p class="hint" id="rec-note"></p>
<ol class="deals" id="rec-list"></ol>
<p id="rec-empty" class="hint" hidden>해당 거래가 없어요.</p>
<button type="button" id="rec-more" class="more" hidden>더 보기</button>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>` };
}

// ---------- 메인 ----------
async function main() {
  if (!RO && !process.env.DATA_GO_KR_KEY) throw fatal('DATA_GO_KR_KEY 환경변수가 없어요 (fixture로 보려면 --fixtures)');
  const now = FIX ? new Date('2026-09-26T00:30:00Z') : new Date();
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const today = kst.toISOString().slice(0, 10);
  STAMP = kst.toISOString().slice(0, 16).replace('T', ' ');
  const ymOf = (d) => d.toISOString().slice(0, 7).replace('-', '');
  const months = [ymOf(kst), ymOf(new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 1, 1)))];
  const since = new Date(kst.getTime() - 60 * 86400e3).toISOString().slice(0, 10);
  const months36 = ymOf(new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 35, 1))); // 36개월 창의 첫 달

  const regions = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));
  const nameCount = {};
  for (const r of regions) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
  const SIDO_SHORT = { 서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 충청북도: '충북', 충청남도: '충남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주', 강원특별자치도: '강원', 전북특별자치도: '전북', 전남광주통합특별시: '전남광주' };
  const label = (r) => (nameCount[r.name] > 1 ? `${SIDO_SHORT[r.sido] || r.sido} ${r.name}` : r.name);

  // 1) 실거래 (매매·전월세)
  const data = Object.fromEntries(regions.map((r) => [r.code, { code: r.code, trade: {}, rent: {}, failed: false }]));
  const tasks = regions.flatMap((r) => months.flatMap((ym) => [['trade', 'RTMSDataSvcAptTradeDev'], ['rent', 'RTMSDataSvcAptRent']].map(([k, op]) => ({ r, ym, k, op }))));
  const failures = [], RAWF = process.env.RAW_CACHE || path.join(HIST, '_raw.json'); // 실제 빌드가 받은 원자료 전부 → --from-cache 가 다시 쓴다
  let raw = null;
  if (CACHE) { raw = JSON.parse(fs.readFileSync(RAWF, 'utf8')); if (!raw.data) raw = { data: raw }; Object.assign(data, raw.data); } // 예전 형식 = 실거래만
  else await pool(tasks, FIX ? 1 : (+process.env.CONC || 3), async (t) => {
    try { data[t.r.code][t.k][t.ym] = await rtms(t.op, t.r.code, t.ym); } catch (e) {
      if (e.fatal) throw e;
      failures.push(`${t.r.sido} ${t.r.name}: ${e.message}`);
      data[t.r.code].failed = true;
    }
  });
  failures.forEach((f) => console.warn('⚠️', f));
  if (failures.length > Math.max(10, tasks.length * 0.1)) throw fatal(`실거래 호출 실패가 너무 많아요 (${failures.length}/${tasks.length})`);

  // 2) 청약홈 APT 분양정보 + 주택형
  const cached = (k, v) => { if (!raw[k]) console.warn(`⚠️ 캐시에 ${k} 없음 — 빈 값으로 그림`); return raw[k] || v; };
  const subs = raw ? cached('subs', []) : (await odcloud('getAPTLttotPblancDetail', { 'cond[RCRIT_PBLANC_DE::GTE]': since }, 'applyhome_detail.json'))
    .filter((x) => x.HOUSE_MANAGE_NO);
  const models = raw ? cached('models', {}) : {};
  if (!raw) await pool(subs, FIX ? 1 : 4, async (x) => {
    try {
      models[x.HOUSE_MANAGE_NO] = await odcloud('getAPTLttotPblancMdl', { 'cond[HOUSE_MANAGE_NO::EQ]': x.HOUSE_MANAGE_NO, 'cond[PBLANC_NO::EQ]': x.PBLANC_NO }, `applyhome_mdl_${x.HOUSE_MANAGE_NO}.json`);
    } catch (e) { if (e.fatal) throw e; console.warn('⚠️ 주택형', x.HOUSE_NM, e.message); }
  });

  // 3) LH 분양·임대 공고 (토지·상가 제외)
  const d8 = (s) => s.replace(/-/g, '');
  const lh = raw ? cached('lh', []) : (await lhNotices(d8(since), d8(today))).filter((x) => !['01', '22'].includes(x.UPP_AIS_TP_CD));
  if (!RO) { fs.mkdirSync(HIST, { recursive: true }); fs.writeFileSync(RAWF, JSON.stringify({ data, subs, models, lh })); }

  // ---------- 쓰기 ----------
  fs.rmSync(OUT, { recursive: true, force: true });
  const indexable = [];
  let pages = 0;
  let pagesDb = {}; try { if (!FIX) pagesDb = JSON.parse(fs.readFileSync(path.join(HIST, '_pages.json'), 'utf8')); } catch {}
  const seenPages = {};
  const write = (p, html, noindex) => { // lastmod = 내용(기준 시각 제외)이 마지막으로 바뀐 날
    const f = path.join(OUT, p.endsWith('/') ? p + 'index.html' : p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
    pages++;
    const hash = require('crypto').createHash('md5').update(html.split(STAMP).join('')).digest('base64').slice(0, 12);
    seenPages[p] = pagesDb[p] && pagesDb[p][0] === hash ? pagesDb[p] : [hash, today];
    if (!noindex) indexable.push(p);
  };
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of ['style.css', 'CNAME', 'today.js', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'og.png', INDEXNOW_KEY + '.txt']) fs.copyFileSync(path.join(__dirname, f), path.join(OUT, f));

  // 1-1) 저장소 갱신 · 신고가 · 단지 페이지(/apt/{aptSeq}/) — 최근 두 달을 저장소에 덮어쓰고, 각 거래를 그보다 이른 거래와 비교
  const since14 = new Date(kst.getTime() - 14 * 86400e3).toISOString().slice(0, 10);
  const recs = { t: [], r: [] }, events = [];
  const openSubs = subs.filter((x) => normDate(x.PRZWNER_PRESNATN_DE || x.RCEPT_ENDDE) >= today);
  const lhOpenAll = lh.filter((x) => normDate(x.CLSG_DT) >= today);
  for (const r of regions) {
    r.sidoShort = SIDO_SHORT[r.sido] || r.sido;
    r.subsHere = openSubs.filter((x) => (x.HSSPLY_ADRES || '').includes(r.sido.slice(0, 2)) && (x.HSSPLY_ADRES || '').includes(r.name)).slice(0, 5);
    r.lhHere = lhOpenAll.filter((x) => (x.CNP_CD_NM || '').slice(0, 2) === r.sido.slice(0, 2)).slice(0, 5);
  }
  let nApt = 0; const aptN = {};
  for (const r of regions) {
    const h = FIX ? emptyHist() : loadHist(r.code), d = data[r.code];
    d.rec = {}; d.cov = {}; const mine = [];
    for (const kind of ['t', 'r']) {
      const H = h[kind], src = d[kind === 't' ? 'trade' : 'rent'];
      pruneHist(H, months36);
      for (const ym of months) if (src[ym]) putMonth(H, ym, kind, src[ym]);
      const found = findRecords(kind, months.flatMap((ym) => src[ym] || []), H).sort((a, b) => b.d.localeCompare(a.d));
      d.rec[kind] = found; d.cov[kind] = H.m.length;
      for (const x of found) {
        events.push({ kind, code: r.code, key: x.key, d: x.d, p: x.p, prev: x.prev, prevDate: x.prevDate, floor: x.r.floor });
        if (d.cov[kind] >= RELIABLE && x.d >= since14) recs[kind].push([r.code.slice(0, 2), `${r.sidoShort} ${r.name}`, r.code, x.r.aptNm, Math.round(+x.r.excluUseAr * 10) / 10, x.r.floor, x.p, x.prev, x.prevDate, x.d,
          (x.r.aptSeq || '').trim(), x.r.umdNm, +x.r.buildYear || 0, x.r.dealingGbn === '직거래' ? 1 : 0, monthly(H.k[x.key]).map((e) => e[1])]); // REC 줄 형식
        if (d.cov[kind] >= RELIABLE && x.d >= since14) mine.push([recs[kind][recs[kind].length - 1], dealId(kind === 't' ? 't' : 'j', x.r)]);
      }
    }
    const j = dealRows(d, h, months, today, h.seen, h.seenX);
    h.seen = j.seen; h.seenX = j.seenX; d.deals = j.deals;
    for (const [row, id] of mine) row.push(j.seen[id] || ''); // 처음 본 날 → 홈 카드 'N일 만에 공개'
    // 단지 페이지: 최근 두 달 거래가 있는 aptSeq
    const seqKeys = {};
    for (const kind of ['t', 'r']) for (const k of Object.keys(h[kind].k)) { const q = k.split('|')[0]; if (/^\d{5}-\d+$/.test(q)) (seqKeys[q] ||= new Set()).add(k); }
    const rowsBy = {};
    for (const ym of months) for (const [kind, rows] of [['t', d.trade[ym]], ['r', d.rent[ym]]]) for (const row of rows || []) {
      const q = (row.aptSeq || '').trim(); if (seqKeys[q]) ((rowsBy[q] ||= { t: [], r: [] })[kind]).push(row);
    }
    const byUmd = {};
    for (const [q, rw] of Object.entries(rowsBy)) { const m = rw.t[0] || rw.r[0]; (byUmd[m.umdNm] ||= []).push([q, m.aptNm, rw.t.length + rw.r.length]); }
    for (const [q, rw] of Object.entries(rowsBy)) {
      const umd = (rw.t[0] || rw.r[0]).umdNm, nb = byUmd[umd].filter((x) => x[0] !== q).sort((a, b) => b[2] - a[2]).slice(0, 10);
      const ap = aptPage(q, r, [...seqKeys[q]], h, rw.t, rw.r, nb, r.subsHere, today);
      write(`/apt/${q}/`, ap.html, ap.noindex); aptN[`/apt/${q}/`] = ap.n;
      nApt++;
    }
    if (!RO) saveHist(r.code, h);
  }
  const collecting = { t: regions.filter((r) => data[r.code].cov.t < RELIABLE), r: regions.filter((r) => data[r.code].cov.r < RELIABLE) };
  for (const k of ['t', 'r']) collecting[k].minCov = Math.min(...collecting[k].map((r) => data[r.code].cov[k]));
  if (!RO) { // 감지 기록: 처음 본 날(seen)과 함께 180일 보관
    const ef = path.join(HIST, 'events.json');
    let old = []; try { old = JSON.parse(fs.readFileSync(ef, 'utf8')); } catch {}
    const id = (e) => [e.kind, e.code, e.key, e.d, e.p, e.floor].join('|'), seen = new Set(old.map(id));
    const cut = new Date(kst.getTime() - 180 * 86400e3).toISOString().slice(0, 10);
    fs.writeFileSync(ef, JSON.stringify([...old.filter((e) => e.seen >= cut), ...events.filter((e) => !seen.has(id(e))).map((e) => ({ ...e, seen: today }))]));
  }
  for (const k of ['t', 'r']) recs[k].sort(REC_SORT.rate);


  const sidos = [];
  for (const r of regions) {
    const d = data[r.code];
    const pg = regionPage(r, label(r), months, d.trade, d.rent, d.failed, d);
    write(`/apt/${r.code}/`, pg.html, pg.noindex);
    r.nT = pg.nT; r.nR = pg.nR;
    r.nCur = (d.trade[months[0]] || []).filter((x) => x.cdealType !== 'O').length;
    const sc = r.code.slice(0, 2);
    let s = sidos.find((x) => x.code === sc);
    if (!s) sidos.push((s = { code: sc, name: r.sido, regs: [] }));
    s.regs.push(r);
  }
  for (const s of sidos) {
    const nT = s.regs.reduce((a, r) => a + r.nT, 0);
    const body = `<p class="hint"><a href="/">홈</a> › ${esc(s.name)}</p>
<h1>${esc(s.name)} 아파트 실거래가 ${ymLabel(months[0])}</h1>
<p class="lead">${esc(s.name)} 시·군·구별 최근 두 달 아파트 매매·전월세 신고 건수예요. 지역을 누르면 단지별 거래를 볼 수 있어요.</p>
${table(['시·군·구', `${ymLabel(months[0]).slice(6)} 매매 `, '2개월 매매 ', '2개월 전월세 '], s.regs.map((r) => '<tr>' +
      td(`<a href="/apt/${r.code}/">${esc(r.name)}</a>`) + td(r.nCur, 1) + td(r.nT, 1) + td(r.nR, 1) + '</tr>'))}`;
    write(`/apt/${s.code}/`, page({ title: `${s.name} 아파트 실거래가 ${ymLabel(months[0])} | 시군구별 | 부동산 알리미`, p: `/apt/${s.code}/`, body,
      desc: `${s.name} 시군구별 아파트 매매 실거래가와 전월세 신고 현황. 최근 두 달 ${nT}건, 매일 갱신.` }));
    s.nT = nT;
  }

  // 오늘 실거래가 /r/{시군구}/{탭}/, 시도 /r/{시도}/, 모음 /today/
  const baseline = !regions.some((r) => data[r.code].deals.some((o) => o.s || o.sx));
  const bySido = {};
  for (const r of regions) (bySido[r.code.slice(0, 2)] ||= []).push(r);
  for (const r of regions) {
    r.tabs = {};
    for (const t of RTABS) {
      const pg = rTabPage(r, t, data[r.code].deals, { today, baseline, sidoRegs: bySido[r.code.slice(0, 2)], subsHere: r.subsHere, lhHere: r.lhHere });
      write(`/r/${r.code}/${t[0]}`, pg.html, !pg.n);
      r.tabs[t[0]] = pg.n;
    }
  }
  const mdLabel = `${+today.slice(5, 7)}월 ${+today.slice(8)}일`, scopeWord = baseline ? '최근 30일 계약' : `${mdLabel} 공개`;
  const RCOLS = [['', '매매'], ['high/', '신고가'], ['up/', '상승'], ['down/', '하락'], ['rent/', '전세'], ['monthly/', '월세'], ['cancel/', '해제']];
  const sumTabs = (rs, t) => rs.reduce((a, r) => a + r.tabs[t], 0);
  for (const [sc, rs] of Object.entries(bySido)) {
    const sido = rs[0].sido;
    write(`/r/${sc}/`, page({ title: `${sido} 아파트 실거래가 ${mdLabel} | 시군구별 ${baseline ? '최근' : '오늘 공개'} ${sumTabs(rs, '')}건 | 부동산 알리미`, p: `/r/${sc}/`,
      desc: `${sido} 시군구별 ${scopeWord} 아파트 매매 ${sumTabs(rs, '')}건, 신고가 ${sumTabs(rs, 'high/')}건, 전세 ${sumTabs(rs, 'rent/')}건. 매일 05시 갱신.`,
      ld: { '@context': 'https://schema.org', ...crumbs([['홈', '/'], ['오늘 실거래가', '/today/'], [sido, `/r/${sc}/`]]) },
      body: `<p class="hint"><a href="/">홈</a> › <a href="/today/">오늘 실거래가</a> › ${esc(sido)}</p>
<h1>${esc(sido)} 아파트 실거래가 ${mdLabel}</h1>
<p class="lead">${esc(sido)} 시·군·구별 ${esc(scopeWord)} 거래 건수예요. 숫자를 누르면 그 목록으로 가요.</p>
${table(['시·군·구', ...RCOLS.map(([, n]) => n + ' ')], rs.map((r) => '<tr>' + td(`<a href="/r/${r.code}/">${esc(r.name)}</a>`) + RCOLS.map(([t]) => td(r.tabs[t] ? `<a href="/r/${r.code}/${t}">${r.tabs[t]}</a>` : '0', 1)).join('') + '</tr>'))}` }));
  }
  write('/today/', page({ title: `오늘 아파트 실거래가 ${mdLabel} | 전국 시군구 신고가·상승·하락 | 부동산 알리미`, p: '/today/',
    desc: `전국 ${scopeWord} 아파트 매매 ${sumTabs(regions, '')}건, 신고가 ${sumTabs(regions, 'high/')}건. 시군구별 직전 거래 대비 변동, 3년 최고·최저, 전세가율.`,
    body: `<h1>오늘 실거래가 <span class="hint">${mdLabel}</span></h1>
<p class="lead">${baseline ? '공개일 수집을 오늘 시작해서, 우선 최근 30일 계약을 보여줘요. 내일부터는 새로 공개된 거래만 모아요.' : '국토교통부 자료에 새로 공개된 아파트 거래를 매일 05시에 모아요.'} 시·군·구를 누르세요.</p>
${table(['시·도', ...RCOLS.map(([, n]) => n + ' ')], Object.entries(bySido).map(([sc, rs]) => '<tr>' + td(`<a href="/r/${sc}/">${esc(rs[0].sido)}</a>`) + RCOLS.map(([t]) => td(sumTabs(rs, t), 1)).join('') + '</tr>'))}
${Object.entries(bySido).map(([sc, rs]) => `<h2><a href="/r/${sc}/">${esc(rs[0].sido)}</a></h2><ul class="chips">${rs.map((r) => `<li><a href="/r/${r.code}/">${esc(r.name)} <span class="c">${r.tabs['']}건</span></a></li>`).join('')}</ul>`).join('\n')}` }));

  // 오늘의 실거래 리포트 /report/YYYY-MM-DD/ — 본문은 history/reports/ 에 남겨 매일 다시 싣는다
  {
    const RD = path.join(HIST, 'reports'), dayDeals = [];
    for (const r of regions) for (const o of data[r.code].deals) if (scopeOf(o, 1, false, today, baseline)) dayDeals.push([o, r]);
    const T = dayDeals.filter(([o]) => o.v === 't' && !o.x), J = dayDeals.filter(([o]) => o.v === 'j');
    const nm = ([o, r]) => `${o.q ? `<a href="/apt/${esc(o.q)}/#a${Math.round(o.ar)}">${esc(o.a)}</a>` : esc(o.a)} <span class="hint">${o.ar}㎡ ${esc(o.f)}층</span>`;
    const rg = (r) => `<a href="/r/${r.code}/">${esc(r.sidoShort)} ${esc(r.name)}</a>`;
    const top = (list, sort, n = 10) => list.slice().sort(sort).slice(0, n);
    const cnt = (sc) => { const f = (pick) => dayDeals.filter(([o, r]) => (!sc || r.code.startsWith(sc)) && pick(o)).length;
      return [f((o) => o.v === 't' && !o.x), f((o) => o.v === 't' && o.r), f((o) => o.v === 'j'), f((o) => o.v === 'w'), f((o) => o.x)]; };
    const rowsC = [['전국', ''], ...Object.entries(bySido).map(([sc, rs]) => [rs[0].sidoShort, sc])].map(([n, sc]) => ['<tr>' + td(sc ? `<a href="/r/${sc}/">${esc(n)}</a>` : '<b>전국</b>') + cnt(sc).map((v) => td(comma(v), 1)).join('') + '</tr>', sc ? cnt(sc)[0] : Infinity]);
    const volume = regions.map((r) => [r, dayDeals.filter(([o, x]) => x === r && o.v === 't' && !o.x).length]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const up = T.filter(([o]) => o.pv && o.p > o.pv[0]), down = T.filter(([o]) => o.pv && o.p < o.pv[0]);
    const byPc = (dir) => (a, b) => dir * ((b[0].p - b[0].pv[0]) / b[0].pv[0] - (a[0].p - a[0].pv[0]) / a[0].pv[0]);
    const jr = T.filter(([o]) => o.jr && o.jr[1] >= 2);
    const recRow = ([o, r]) => '<tr>' + td(rg(r)) + td(nm([o, r])) + td(`<b>${fmtWon(o.p)}</b>`, 1) + td(`${fmtWon(o.hi[0])}<br><span class="hint">${ymd2(o.hi[2])}</span>`, 1) + td(chgH(o.p, o.hi[0]), 1) + '</tr>';
    const chgRow = ([o, r]) => '<tr>' + td(rg(r)) + td(nm([o, r])) + td(`<b>${fmtWon(o.p)}</b>`, 1) + td(`${fmtWon(o.pv[0])}<br><span class="hint">${ymd2(o.pv[2])}</span>`, 1) + td(chgH(o.p, o.pv[0]), 1) + '</tr>';
    const RH = ['지역', '단지', '거래가 ', '이전 최고 ', '차이 '], CH = ['지역', '단지', '거래가 ', '직전거래 ', '변동 '];
    const dLabel = `${today.slice(0, 4)}년 ${+today.slice(5, 7)}월 ${+today.slice(8)}일`;
    const scopeTxt = baseline ? '최근 30일 계약 기준 (공개일 수집 첫날)' : `${today.replace(/-/g, '.')} 새로 공개된 거래 기준 (05시 수집)`;
    const topRec = top(T.filter(([o]) => o.r), (a, b) => b[0].p - a[0].p)[0];
    let body = `<p class="hint"><a href="/">홈</a> › <a href="/report/">실거래 리포트</a> › ${today}</p>
<h1>${dLabel} 아파트 실거래 리포트</h1>
<p class="lead">${esc(scopeTxt)}. 매매 ${comma(T.length)}건, 신고가 ${comma(T.filter(([o]) => o.r).length)}건, 전세 ${comma(J.length)}건. 신고가·변동은 같은 단지·같은 전용면적(㎡ 반올림)에서 계약일이 더 이른 거래(최대 3년)와 비교했고 해제 거래는 뺐어요.</p>
<h2>시도별 건수</h2>${table(['지역', '매매 ', '신고가 ', '전세 ', '월세 ', '해제 '], rowsC.sort((a, b) => b[1] - a[1]).map((x) => x[0]))}
<h2>🔥 매매 신고가 TOP 10</h2>${table(RH, top(T.filter(([o]) => o.r), (a, b) => b[0].p - a[0].p).map(recRow))}
<h2>🔥 전세 신고가 TOP 10</h2>${table(RH, top(J.filter(([o]) => o.r), (a, b) => b[0].p - a[0].p).map(recRow))}
<h2>📈 직전 거래 대비 상승 TOP 10</h2>${table(CH, top(up, byPc(1)).map(chgRow))}
<h2>📉 직전 거래 대비 하락 TOP 10</h2>${table(CH, top(down, byPc(-1)).map(chgRow))}
<h2>거래 많은 시·군·구 TOP 10</h2>${table(['지역', '매매 '], volume.map(([r, n]) => '<tr>' + td(rg(r)) + td(`<a href="/r/${r.code}/">${n}</a>`, 1) + '</tr>'))}
<h2>전세가율 높은 거래 TOP 10</h2><p class="hint">전세가율 = 계약일 전 6개월 전세(갱신 제외) 중위값 ÷ 매매가, 전세 2건 이상인 곳만.</p>${table(['지역', '단지', '거래가 ', '전세 중위 ', '전세가율 '], top(jr, (a, b) => b[0].jr[0] / b[0].p - a[0].jr[0] / a[0].p).map(([o, r]) => '<tr>' + td(rg(r)) + td(nm([o, r])) + td(fmtWon(o.p), 1) + td(`${fmtWon(o.jr[0])} <span class="hint">${o.jr[1]}건</span>`, 1) + td(`<b>${pct(o.jr[0], o.p)}%</b>`, 1) + '</tr>'))}
<p><a href="/today/">시군구별 오늘 실거래가 →</a> · <a href="/report/">지난 리포트</a></p>`;
    body = body.split('<div class="scroll">').join('<div class="scroll nw">');
    const rep = { title: `${dLabel} 아파트 실거래 리포트 | 신고가·상승·하락·거래량 | 부동산 알리미`, p: `/report/${today}/`, body,
      desc: `${dLabel} 아파트 실거래: 매매 ${T.length}건, 신고가 ${T.filter(([o]) => o.r).length}건, 전세 ${J.length}건.${topRec ? ` 최고 신고가 ${topRec[0].a} ${fmtWon(topRec[0].p)}.` : ''} 시도별 건수, 상승·하락 TOP 10, 전세가율.`,
      ld: { '@context': 'https://schema.org', '@graph': [crumbs([['홈', '/'], ['실거래 리포트', '/report/'], [today, `/report/${today}/`]]), { '@type': 'Article', headline: `${dLabel} 아파트 실거래 리포트`, datePublished: today, dateModified: today, author: { '@type': 'Organization', name: '부동산 알리미' } }] } };
    if (!RO) { fs.mkdirSync(RD, { recursive: true }); fs.writeFileSync(path.join(RD, today + '.json'), JSON.stringify(rep)); }
    const saved = [rep, ...(FIX || !fs.existsSync(RD) ? [] : fs.readdirSync(RD).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f) && f !== today + '.json').sort().reverse().map((f) => JSON.parse(fs.readFileSync(path.join(RD, f), 'utf8'))))];
    for (const x of saved) write(x.p, page(x));
    const pub = (x) => new Date(x.p.slice(8, 18) + 'T05:00:00+09:00').toUTCString(); // /report/YYYY-MM-DD/
    fs.writeFileSync(path.join(OUT, 'rss.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>부동산 알리미 실거래 리포트</title><link>${SITE}/report/</link><description>매일 05시 새로 공개된 아파트 실거래: 신고가·상승·하락 TOP 10</description><language>ko</language><lastBuildDate>${pub(saved[0])}</lastBuildDate>
${saved.slice(0, 30).map((x) => `<item><title>${esc(x.title.split(' | ')[0])}</title><link>${SITE}${x.p}</link><guid>${SITE}${x.p}</guid><pubDate>${pub(x)}</pubDate><description>${esc(x.desc)}</description></item>`).join('\n')}
</channel></rss>
`);
    write('/report/', page({ title: '아파트 실거래 리포트 | 날짜별 신고가·상승·하락 | 부동산 알리미', p: '/report/',
      desc: '날짜별 아파트 실거래 리포트: 새로 공개된 거래의 시도별 건수, 신고가 TOP 10, 상승·하락 TOP 10, 거래 많은 지역.',
      body: `<h1>아파트 실거래 리포트</h1><p class="lead">매일 05시 수집한 새 공개 거래를 한 페이지로 정리해요.</p><ul class="rec">${saved.map((x) => `<li><a href="${x.p}">${esc(x.title.split(' | ')[0])}</a> <span class="hint">${esc(x.desc.split(':')[1] || '').split('.')[0]}</span></li>`).join('')}</ul>` }));
  }

  // 청약
  const open = subs.filter((x) => normDate(x.PRZWNER_PRESNATN_DE || x.RCEPT_ENDDE) >= today).sort((a, b) => normDate(a.RCEPT_BGNDE).localeCompare(normDate(b.RCEPT_BGNDE)));
  const closed = subs.filter((x) => !open.includes(x)).sort((a, b) => normDate(b.RCEPT_BGNDE).localeCompare(normDate(a.RCEPT_BGNDE)));
  write('/subscription/', page({ title: `아파트 청약 일정 ${ymLabel(months[0])} | 접수 중·예정 분양 | 부동산 알리미`, p: '/subscription/',
    desc: `청약홈 APT 분양 공고 중 접수 중이거나 예정인 ${open.length}곳의 청약 접수 기간, 당첨자 발표일, 공급 규모. 매일 갱신.`,
    body: `<h1>아파트 청약 일정</h1>
<p class="lead">한국부동산원 청약홈에 올라온 APT 분양 공고예요. 접수 시작일 순으로 정리했어요. 단지명을 누르면 주택형별 분양가를 볼 수 있어요.</p>
<p>👉 내 점수부터: <a href="${CALC}/subscription/">청약 가점 계산기</a> · <a href="${benefitSub(today)}">청약 가점 계산법 (혜택 알리미)</a></p>
<h2>접수 중·예정 (${open.length}곳)</h2>${table(SUB_HEAD, open.map(subRow))}
<h2>최근 마감 (${closed.length}곳)</h2>${table(SUB_HEAD, closed.map(subRow))}` }));
  for (const x of subs) write(`/subscription/${x.HOUSE_MANAGE_NO}/`, subDetail(x, models[x.HOUSE_MANAGE_NO], today));

  // LH
  const lhRow = (x) => '<tr>' + td(link(x.DTL_URL, esc(x.PAN_NM))) + td(esc(x.CNP_CD_NM)) + td(esc([x.UPP_AIS_TP_NM, x.AIS_TP_CD_NM].filter((v, i, a) => v && a.indexOf(v) === i).join(' · '))) +
    td(esc(x.PAN_SS)) + td(md(x.PAN_NT_ST_DT)) + td(md(x.CLSG_DT)) + '</tr>';
  const lhOpen = lh.filter((x) => normDate(x.CLSG_DT) >= today).sort((a, b) => normDate(a.CLSG_DT).localeCompare(normDate(b.CLSG_DT)));
  const lhClosed = lh.filter((x) => !lhOpen.includes(x)).sort((a, b) => normDate(b.PAN_NT_ST_DT).localeCompare(normDate(a.PAN_NT_ST_DT)));
  const LH_HEAD = ['공고명', '지역', '유형', '상태', '게시일', '마감일'];
  write('/lh/', page({ title: `LH 분양·임대 공고 ${ymLabel(months[0])} | 행복주택·국민임대·공공분양 | 부동산 알리미`, p: '/lh/',
    desc: `LH청약플러스 분양·임대 공고 ${lh.length}건 (마감 전 ${lhOpen.length}건). 공고명, 지역, 유형, 게시일, 마감일을 매일 갱신.`,
    body: `<h1>LH 분양·임대 공고</h1>
<p class="lead">한국토지주택공사(LH)가 최근 두 달 게시한 분양주택·임대주택·신혼희망타운 공고예요 (토지·상가 제외). 공고명을 누르면 LH청약플러스 원문으로 가요.</p>
<h2>마감 전 (${lhOpen.length}건, 마감 임박순)</h2>${table(LH_HEAD, lhOpen.map(lhRow))}
<h2>마감 (${lhClosed.length}건)</h2>${table(LH_HEAD, lhClosed.map(lhRow))}` }));

  // 홈
  const recHome = recSection(recs, collecting, sidos, +today.slice(0, 4));
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data', 'rec.json'), recHome.json);
  write('/', page({ title: '부동산 알리미 | 아파트 실거래가·청약 일정·LH 공고 매일 갱신', p: '/',
    desc: '전국 시군구 아파트 매매·전월세 실거래가, 청약홈 분양 일정, LH 분양·임대 공고를 공공데이터로 매일 새벽 갱신해요.',
    body: `<h1>부동산 알리미</h1>
<p class="lead">전국 아파트 실거래가와 청약·LH 공고를 공공데이터로 매일 새벽 모아 보여줘요.</p>
${recHome.html}
<p><a class="cta" href="/report/${today}/">📊 ${+today.slice(5, 7)}월 ${+today.slice(8)}일 실거래 리포트 — 신고가·상승·하락 TOP 10 →</a></p>
<p><a class="cta" href="/today/">📋 오늘 실거래가 — 시군구별 새로 공개된 매매·전세·월세, 신고가·상승·하락·해제 거래 보기 →</a></p>
<h2>🏢 지역별 아파트 실거래가 (${months.map(ymLabel).join('·')})</h2>
<ul class="chips">${sidos.map((s) => `<li><a href="/apt/${s.code}/">${esc(s.name)} <span class="c">${comma(s.nT)}건</span></a></li>`).join('')}</ul>
<h2>📝 접수 중·예정 청약 (${open.length}곳)</h2>${table(SUB_HEAD, open.slice(0, 8).map(subRow))}
<p><a href="/subscription/">청약 일정 전체 보기 →</a></p>
<h2>🏠 마감 전 LH 공고 (${lhOpen.length}건)</h2>${table(LH_HEAD, lhOpen.slice(0, 8).map(lhRow))}
<p><a href="/lh/">LH 공고 전체 보기 →</a></p>` }));

  write('/privacy.html', page({ title: '개인정보처리방침 | 부동산 알리미', p: '/privacy.html', desc: '부동산 알리미 개인정보처리방침',
    body: `<h1>개인정보처리방침</h1><div class="card">
<p>부동산 알리미(home.hanbogi.com)는 회원가입이 없고 <b>개인정보를 수집하거나 저장하지 않아요</b>. 모든 페이지는 공공데이터로 미리 만든 정적 페이지예요.</p>
<p>이 사이트는 Google 애드센스 광고를 게재할 수 있어요. Google 및 제3자 광고 사업자는 쿠키를 사용해 이 사이트와 다른 사이트 방문 기록을 바탕으로 광고를 제공할 수 있어요. <a href="https://adssettings.google.com" rel="nofollow">Google 광고 설정</a>에서 맞춤 광고를 끌 수 있어요.</p>
<p>문의: 혜택 알리미 블로그(<a href="https://benefit.hanbogi.com">benefit.hanbogi.com</a>) 방명록</p>
<p class="hint">시행일: 2026년 9월 26일</p></div>` }));
  write('/about.html', page({ title: '부동산 알리미 소개 | 데이터 출처·갱신 주기·신고가 기준', p: '/about.html', desc: '부동산 알리미는 국토교통부·한국부동산원·LH 공공데이터로 전국 아파트 실거래가·신고가·청약·LH 공고를 매일 05시에 갱신하는 무료 사이트예요.',
    body: `<h1>부동산 알리미 소개</h1>
<div class="card"><h2>운영 목적</h2><p>흩어져 있는 아파트 실거래가·청약 일정·LH 공고를 한곳에서 빠르게 확인하도록 돕는 무료 정보 사이트예요. 회원가입 없이 누구나 볼 수 있어요.</p>
<h2>데이터 출처</h2><ul>
<li>아파트 매매·전월세 실거래가: 국토교통부 실거래가 공개시스템 (공공데이터포털 API)</li>
<li>APT 분양 청약 일정·주택형별 분양가: 한국부동산원 청약홈 (공공데이터포털 API)</li>
<li>분양·임대 공고: 한국토지주택공사(LH) 청약플러스 (공공데이터포털 API)</li></ul>
<h2>갱신 주기</h2><p>매일 새벽 05시(KST)에 최근 두 달 자료를 다시 받아 모든 페이지를 새로 만들어요. 각 페이지 아래에 기준 시각이 적혀 있어요.</p>
<h2>신고가 기준</h2><p>같은 단지·같은 전용면적(㎡ 반올림)에서 <b>계약일이 더 이른 거래(최대 3년)</b>의 최고가보다 비싼 거래를 신고가로 봐요. 이전 거래가 없는 첫 거래는 신고가가 아니에요. 매매는 계약 해제 거래를, 전세는 월세(월세 0원 초과) 거래를 빼고 비교해요. 같은 값은 '최고가 동률'로 따로 표시해요.</p>
<h2>면책</h2><p>모든 정보는 참고용이에요. 실거래가는 신고 기준이라 해제·정정 신고로 나중에 바뀌거나 빠질 수 있고, 청약·LH 일정도 바뀔 수 있어요. 투자·계약 판단 전에는 반드시 원문 공고와 공식 자료를 확인하세요. 이 정보로 생긴 손해에 대해 운영자는 책임지지 않아요.</p>
<h2>운영</h2><p>운영: 한보기 (hanbogi.com 네트워크)<br>문의: <a href="https://benefit.hanbogi.com/guestbook">혜택 알리미 방명록</a></p></div>` }));
  write('/404.html', page({ title: '페이지를 찾을 수 없어요 | 부동산 알리미', p: '/404.html', desc: '페이지를 찾을 수 없어요', noindex: true,
    body: '<h1>페이지를 찾을 수 없어요</h1><p class="lead">주소가 바뀌었거나 지난 공고일 수 있어요.</p><p><a href="/">홈으로</a> · <a href="/subscription/">청약 일정</a> · <a href="/lh/">LH 공고</a></p>' }), true);

  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  // 사이트맵: 색인(sitemap.xml) → 일반·지역(/r/)·단지(/apt/{aptSeq}/ 5만 개씩)
  const urlset = (ps) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${ps.map((p) => `<url><loc>${SITE}${p}</loc><lastmod>${seenPages[p][1]}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  const isApt = (p) => /^\/apt\/\d{5}-\d+\/$/.test(p), groups = { main: indexable.filter((p) => !p.startsWith('/r/') && !isApt(p)), regions: indexable.filter((p) => p.startsWith('/r/')) };
  const apts = indexable.filter(isApt).sort((a, b) => (aptN[b] || 0) - (aptN[a] || 0) || a.localeCompare(b));
  groups['apt-hot'] = apts.slice(0, APT_HOT);
  for (let i = 0; APT_HOT + i * 50000 < apts.length; i++) groups['apt-rest' + (i ? '-' + (i + 1) : '')] = apts.slice(APT_HOT + i * 50000, APT_HOT + (i + 1) * 50000);
  const smFiles = Object.entries(groups).filter(([, ps]) => ps.length).map(([n, ps]) => { fs.writeFileSync(path.join(OUT, `sitemap-${n}.xml`), urlset(ps)); return [n, ps.reduce((m, p) => (seenPages[p][1] > m ? seenPages[p][1] : m), '')]; });
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${smFiles.map(([n, lm]) => `<sitemap><loc>${SITE}/sitemap-${n}.xml</loc><lastmod>${lm}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`);
  if (!RO) fs.writeFileSync(path.join(HIST, '_pages.json'), JSON.stringify(seenPages));

  console.log(`완료: 페이지 ${pages}개 (색인 ${indexable.length}, 단지 ${nApt} 중 색인 ${indexable.filter(isApt).length}), 공개일 기준선 ${baseline ? '예(첫 수집)' : '아니오'}, 실거래 실패 ${failures.length}/${tasks.length}, 청약 ${subs.length}, LH ${lh.length}`);
  console.log('API 호출 수:', FIX ? '(fixtures)' : CACHE ? '(캐시, 0회)' : JSON.stringify(calls));
}

module.exports = { REC_SORT, recCard, recFilter, sggOpts, dealId, ymd2, recSection, fmtWon, median, normDate, areaBand, parseRtms, toMan, recKey, recPrice, putMonth, priorStats, findRecords, dealRows, chg, pct, jeonseMedian, pruneHist, emptyHist, loadHist, saveHist, rtms, calls, pool, RELIABLE, HIST };
if (require.main === module) main().catch((e) => { console.error('❌ 빌드 실패:', e.message); process.exit(1); });
