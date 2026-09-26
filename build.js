#!/usr/bin/env node
// 부동산 알리미 정적 사이트 생성기. 의존성 없음 (Node 20+ fetch).
//   node build.js             — 공공데이터포털 API 호출 (env DATA_GO_KR_KEY = 디코딩 키)
//   node build.js --fixtures  — fixtures/ 의 저장된 응답으로 생성 (키 불필요)
'use strict';
const fs = require('fs');
const path = require('path');

const FIX = process.argv.includes('--fixtures');
const SITE = 'https://home.hanbogi.com';
const CALC = 'https://calc.hanbogi.com';
const OUT = path.join(__dirname, 'dist');
const CAP = 4000; // API별 1회 실행 호출 상한 (일일 한도 10,000)
const FATAL_CODES = new Set(['12', '20', '21', '22', '30', '31', '32']); // 서비스 없음·접근거부·키 문제·한도 초과
const BANDS = ['60㎡ 이하', '60~85㎡', '85~135㎡', '135㎡ 초과'];
const ROW_LIMIT = 200; // 월별 표에 보여줄 최대 거래 수

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

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- 렌더 ----------
let STAMP = '';
function page({ title, desc, p, body, noindex }) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${p}">${noindex ? '\n<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${p}">
<link rel="stylesheet" href="/style.css">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5424435978828190" crossorigin="anonymous"></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-19F8RF6971"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-19F8RF6971");</script>
</head>
<body>
<header><a href="/">부동산 알리미</a></header>
<main>
${body}
<p class="warn">⚠️ 참고용 정보예요. 실거래가는 <b>신고 기준</b>이라 계약 해제·정정 신고로 나중에 바뀌거나 빠질 수 있어요. 청약·LH 공고는 일정이 바뀔 수 있으니 반드시 원문 공고문을 확인하세요.</p>
<div class="card"><b>🧮 함께 쓰는 계산기</b>
<ul class="chips" style="margin:10px 0 0"><li><a href="${CALC}/subscription/">청약 가점 계산기</a></li><li><a href="${CALC}/acquisition-tax/">취득세 계산기</a></li><li><a href="${CALC}/brokerage/">중개수수료 계산기</a></li><li><a href="${CALC}/loan/">주택담보대출 계산기</a></li><li><a href="${CALC}/rent/">전월세 전환 계산기</a></li></ul></div>
</main>
<footer>데이터 출처: 국토교통부/한국부동산원/LH (공공데이터포털), 기준 시각 ${STAMP} KST<br>
© 부동산 알리미 · <a href="/">홈</a> · <a href="/subscription/">청약 일정</a> · <a href="/lh/">LH 공고</a> · <a href="/privacy.html">개인정보처리방침</a> · <a href="${CALC}/">한눈 계산기</a></footer>
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

function regionPage(reg, label, months, trade, rent, failed) {
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
    html: page({ title: title + ' | 부동산 알리미', p: `/apt/${reg.code}/`, body, noindex: nT + nR === 0 || failed,
      desc: `${reg.sido} ${reg.name} 아파트 매매 실거래가 ${nT}건과 전월세 ${nR}건. 단지·면적·층·거래금액과 면적대별 중위가격을 매일 갱신해요.` }),
  };
}

function subRow(x) {
  return '<tr>' + td(esc(x.SUBSCRPT_AREA_CODE_NM)) + td(`<a href="/subscription/${esc(x.HOUSE_MANAGE_NO)}/">${esc(x.HOUSE_NM)}</a>`) +
    td(x.TOT_SUPLY_HSHLDCO ? comma(x.TOT_SUPLY_HSHLDCO) + '세대' : '-', 1) + td(`${md(x.RCEPT_BGNDE)}~${md(x.RCEPT_ENDDE)}`) + td(md(x.PRZWNER_PRESNATN_DE)) +
    td(link(x.PBLANC_URL, '청약홈')) + '</tr>';
}
const SUB_HEAD = ['지역', '단지명', '공급 ', '청약접수', '당첨발표', '원문'];

function subDetail(x, models) {
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
<p>내 청약 가점이 궁금하면 <a href="${CALC}/subscription/">청약 가점 계산기</a>, 분양가 기준 세금은 <a href="${CALC}/acquisition-tax/">취득세 계산기</a>로 확인하세요.</p>`;
  return page({ title: `${x.HOUSE_NM} 청약 일정·분양가 | 부동산 알리미`, p: `/subscription/${x.HOUSE_MANAGE_NO}/`, body,
    desc: `${x.HOUSE_NM} (${x.SUBSCRPT_AREA_CODE_NM}) 청약 접수 ${normDate(x.RCEPT_BGNDE)}~${normDate(x.RCEPT_ENDDE)}, 당첨자 발표 ${normDate(x.PRZWNER_PRESNATN_DE)}. 주택형별 공급세대와 분양가.` });
}

// ---------- 메인 ----------
async function main() {
  if (!FIX && !process.env.DATA_GO_KR_KEY) throw fatal('DATA_GO_KR_KEY 환경변수가 없어요 (fixture로 보려면 --fixtures)');
  const now = FIX ? new Date('2026-09-26T00:30:00Z') : new Date();
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const today = kst.toISOString().slice(0, 10);
  STAMP = kst.toISOString().slice(0, 16).replace('T', ' ');
  const ymOf = (d) => d.toISOString().slice(0, 7).replace('-', '');
  const months = [ymOf(kst), ymOf(new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 1, 1)))];
  const since = new Date(kst.getTime() - 60 * 86400e3).toISOString().slice(0, 10);

  const regions = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));
  const nameCount = {};
  for (const r of regions) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
  const SIDO_SHORT = { 서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 충청북도: '충북', 충청남도: '충남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주', 강원특별자치도: '강원', 전북특별자치도: '전북', 전남광주통합특별시: '전남광주' };
  const label = (r) => (nameCount[r.name] > 1 ? `${SIDO_SHORT[r.sido] || r.sido} ${r.name}` : r.name);

  // 1) 실거래 (매매·전월세)
  const data = Object.fromEntries(regions.map((r) => [r.code, { trade: {}, rent: {}, failed: false }]));
  const tasks = regions.flatMap((r) => months.flatMap((ym) => [['trade', 'RTMSDataSvcAptTradeDev'], ['rent', 'RTMSDataSvcAptRent']].map(([k, op]) => ({ r, ym, k, op }))));
  const failures = [];
  await pool(tasks, FIX ? 1 : (+process.env.CONC || 3), async (t) => {
    try { data[t.r.code][t.k][t.ym] = await rtms(t.op, t.r.code, t.ym); } catch (e) {
      if (e.fatal) throw e;
      failures.push(`${t.r.sido} ${t.r.name}: ${e.message}`);
      data[t.r.code].failed = true;
    }
  });
  failures.forEach((f) => console.warn('⚠️', f));
  if (failures.length > Math.max(10, tasks.length * 0.1)) throw fatal(`실거래 호출 실패가 너무 많아요 (${failures.length}/${tasks.length})`);

  // 2) 청약홈 APT 분양정보 + 주택형
  const subs = (await odcloud('getAPTLttotPblancDetail', { 'cond[RCRIT_PBLANC_DE::GTE]': since }, 'applyhome_detail.json'))
    .filter((x) => x.HOUSE_MANAGE_NO);
  const models = {};
  await pool(subs, FIX ? 1 : 4, async (x) => {
    try {
      models[x.HOUSE_MANAGE_NO] = await odcloud('getAPTLttotPblancMdl', { 'cond[HOUSE_MANAGE_NO::EQ]': x.HOUSE_MANAGE_NO, 'cond[PBLANC_NO::EQ]': x.PBLANC_NO }, `applyhome_mdl_${x.HOUSE_MANAGE_NO}.json`);
    } catch (e) { if (e.fatal) throw e; console.warn('⚠️ 주택형', x.HOUSE_NM, e.message); }
  });

  // 3) LH 분양·임대 공고 (토지·상가 제외)
  const d8 = (s) => s.replace(/-/g, '');
  const lh = (await lhNotices(d8(since), d8(today))).filter((x) => !['01', '22'].includes(x.UPP_AIS_TP_CD));

  // ---------- 쓰기 ----------
  fs.rmSync(OUT, { recursive: true, force: true });
  const indexable = [];
  let pages = 0;
  const write = (p, html, noindex) => {
    const f = path.join(OUT, p.endsWith('/') ? p + 'index.html' : p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
    pages++;
    if (!noindex) indexable.push(p);
  };
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of ['style.css', 'CNAME']) fs.copyFileSync(path.join(__dirname, f), path.join(OUT, f));

  const sidos = [];
  for (const r of regions) {
    const d = data[r.code];
    const pg = regionPage(r, label(r), months, d.trade, d.rent, d.failed);
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

  // 청약
  const open = subs.filter((x) => normDate(x.PRZWNER_PRESNATN_DE || x.RCEPT_ENDDE) >= today).sort((a, b) => normDate(a.RCEPT_BGNDE).localeCompare(normDate(b.RCEPT_BGNDE)));
  const closed = subs.filter((x) => !open.includes(x)).sort((a, b) => normDate(b.RCEPT_BGNDE).localeCompare(normDate(a.RCEPT_BGNDE)));
  write('/subscription/', page({ title: `아파트 청약 일정 ${ymLabel(months[0])} | 접수 중·예정 분양 | 부동산 알리미`, p: '/subscription/',
    desc: `청약홈 APT 분양 공고 중 접수 중이거나 예정인 ${open.length}곳의 청약 접수 기간, 당첨자 발표일, 공급 규모. 매일 갱신.`,
    body: `<h1>아파트 청약 일정</h1>
<p class="lead">한국부동산원 청약홈에 올라온 APT 분양 공고예요. 접수 시작일 순으로 정리했어요. 단지명을 누르면 주택형별 분양가를 볼 수 있어요.</p>
<h2>접수 중·예정 (${open.length}곳)</h2>${table(SUB_HEAD, open.map(subRow))}
<h2>최근 마감 (${closed.length}곳)</h2>${table(SUB_HEAD, closed.map(subRow))}` }));
  for (const x of subs) write(`/subscription/${x.HOUSE_MANAGE_NO}/`, subDetail(x, models[x.HOUSE_MANAGE_NO]));

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
  write('/', page({ title: '부동산 알리미 | 아파트 실거래가·청약 일정·LH 공고 매일 갱신', p: '/',
    desc: '전국 시군구 아파트 매매·전월세 실거래가, 청약홈 분양 일정, LH 분양·임대 공고를 공공데이터로 매일 새벽 갱신해요.',
    body: `<h1>부동산 알리미</h1>
<p class="lead">전국 아파트 실거래가와 청약·LH 공고를 공공데이터로 매일 새벽 모아 보여줘요.</p>
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
  write('/404.html', page({ title: '페이지를 찾을 수 없어요 | 부동산 알리미', p: '/404.html', desc: '페이지를 찾을 수 없어요', noindex: true,
    body: '<h1>페이지를 찾을 수 없어요</h1><p class="lead">주소가 바뀌었거나 지난 공고일 수 있어요.</p><p><a href="/">홈으로</a> · <a href="/subscription/">청약 일정</a> · <a href="/lh/">LH 공고</a></p>' }), true);

  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable.map((p) => `<url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);

  console.log(`완료: 페이지 ${pages}개 (색인 ${indexable.length}), 실거래 실패 ${failures.length}/${tasks.length}, 청약 ${subs.length}, LH ${lh.length}`);
  console.log('API 호출 수:', FIX ? '(fixtures)' : JSON.stringify(calls));
}

module.exports = { fmtWon, median, normDate, areaBand, parseRtms, toMan };
if (require.main === module) main().catch((e) => { console.error('❌ 빌드 실패:', e.message); process.exit(1); });
