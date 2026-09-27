// node test.js — 핵심 순수 함수 검사
const assert = require('assert');
const fs = require('fs');
const { fmtWon, median, normDate, areaBand, parseRtms, toMan, recKey, putMonth, findRecords, emptyHist, dealRows, chg, pct, jeonseMedian } = require('./build.js');

assert.strictEqual(fmtWon(123500), '12억 3,500만');
assert.strictEqual(fmtWon(120000), '12억');
assert.strictEqual(fmtWon(8500), '8,500만');
assert.strictEqual(fmtWon(10001), '1억 1만');
assert.strictEqual(toMan(' 245,000'), 245000);
assert.strictEqual(toMan(' '), 0);

assert.strictEqual(median([]), null);
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([100, 200, 400, 300]), 250);

assert.strictEqual(normDate('2026.09.01'), '2026-09-01');
assert.strictEqual(normDate('20260901'), '2026-09-01');
assert.strictEqual(normDate('2026-09-01'), '2026-09-01');
assert.strictEqual(normDate(null), '');
assert.strictEqual(normDate('26.09'), '');

assert.strictEqual(areaBand(59.99), '60㎡ 이하');
assert.strictEqual(areaBand(84.99), '60~85㎡');
assert.strictEqual(areaBand(85.01), '85~135㎡');

const ok = parseRtms(fs.readFileSync(__dirname + '/fixtures/RTMSDataSvcAptTradeDev_11680_202609.xml', 'utf8'));
assert.strictEqual(ok.code, '000');
assert.strictEqual(ok.total, 6);
assert.strictEqual(ok.items[0].aptNm, '개포자이프레지던스');
assert.strictEqual(ok.items[5].cdealType, 'O');
const err = parseRtms(fs.readFileSync(__dirname + '/fixtures/RTMSDataSvcAptTradeDev_11110_202609.xml', 'utf8'));
assert.strictEqual(err.code, '05');
assert.strictEqual(parseRtms('Unauthorized').code, 'NOXML');

// 신고가
const T = (day, amt, o = {}) => ({ aptSeq: '11680-1', excluUseAr: '84.97', dealYear: '2026', dealMonth: '9', dealDay: String(day), dealAmount: amt, floor: '10', cdealType: ' ', ...o });
assert.strictEqual(recKey(T(1, 1)), recKey(T(1, 1, { excluUseAr: '85.4' })));          // 84.97·85.4 → 85㎡ 같은 키
assert.notStrictEqual(recKey(T(1, 1)), recKey(T(1, 1, { excluUseAr: '84.4' })));       // 84.4 → 84㎡ 다른 키
assert.strictEqual(recKey({ aptSeq: '', sggCd: '11680', umdNm: '대치동', aptNm: '은마', jibun: '316', excluUseAr: '76.79' }), '11680/대치동/은마/316|77');
const rec = (kind, rows, older = []) => { const H = emptyHist()[kind]; putMonth(H, '202608', kind, older); putMonth(H, '202609', kind, rows); return findRecords(kind, rows, H).map((x) => x.r.dealDay + ':' + x.p + '>' + x.prev); };
const aug = (day, amt, o) => T(day, amt, { dealMonth: '8', ...o });
assert.deepStrictEqual(rec('t', [T(5, '100,000')]), []);                                  // 첫 거래는 신고가 아님
assert.deepStrictEqual(rec('t', [T(5, '100,000')], [aug(20, '90,000')]), ['5:100000>90000']);
assert.deepStrictEqual(rec('t', [T(5, '100,000'), T(5, '90,000')]), []);             // 같은 날 거래끼리는 비교 안 함
assert.deepStrictEqual(rec('t', [T(5, '90,000'), T(20, '120,000')]), ['20:120000>90000']);
assert.deepStrictEqual(rec('t', [T(5, '100,000'), T(20, '120,000')], [aug(1, '110,000')]), ['20:120000>110000']); // 9/5는 8/1 최고가 미달
assert.deepStrictEqual(rec('t', [T(5, '100,000'), T(20, '80,000')]), []);             // 나중 거래(9/20)가 9/5의 비교 대상이 되지 않음
assert.deepStrictEqual(rec('t', [T(20, '100,000')], [aug(1, '90,000'), aug(9, '150,000', { cdealType: 'O' })]), ['20:100000>90000']); // 해제 거래는 기록·비교 모두 제외
assert.deepStrictEqual(rec('t', [T(20, '200,000', { cdealType: 'O' })], [aug(1, '90,000')]), []);
const J = (day, dep, rent, o) => T(day, undefined, { deposit: dep, monthlyRent: rent, ...o });
assert.deepStrictEqual(rec('r', [J(20, '60,000', '0')], [J(1, '50,000', '0', { dealMonth: '8' }), J(2, '90,000', '100', { dealMonth: '8' })]), ['20:60000>50000']); // 월세는 제외
assert.deepStrictEqual(rec('r', [J(20, '99,000', '50')], [J(1, '50,000', '0', { dealMonth: '8' })]), []);
{ const H = emptyHist().t; putMonth(H, '202609', 't', [T(5, '100,000'), T(6, '100,000')]); putMonth(H, '202609', 't', [T(5, '100,000')]); // 같은 달 다시 넣으면 교체
  assert.strictEqual(H.k[recKey(T(1, 1))].length, 1); assert.deepStrictEqual(H.m, ['202609']); }

// 벤치마킹 명세 검증
assert.deepStrictEqual(chg(62800, 61500), [1300, '2.1']);                                       // 변동률 +2.1%
assert.strictEqual(pct(62800, 74000), 85);                                                       // 최고가 대비 85%
assert.deepStrictEqual(rec('t', [T(20, '90,000')], [aug(1, '90,000')]), []);                 // 동률은 신고가 아님
{ // 직전거래·신고가 표시: 해제 제외, 같은 날 여러 건이어도 한 줄씩, firstSeen 고정
  const h = emptyHist(), rows = [T(10, '90,000'), T(10, '91,000', { floor: '3' }), T(12, '99,000', { cdealType: 'O', cdealDay: '26.09.20' }), T(15, '95,000')];
  putMonth(h.t, '202609', 't', rows);
  const d = { trade: { 202609: rows }, rent: {} };
  const a = dealRows(d, h, ['202609'], '2026-09-26', {}, {});
  assert.strictEqual(a.deals.length, 4);                                                          // 중복 행 없음
  const last = a.deals[3];
  assert.strictEqual(last.pv[0], 91000);                                                          // 직전 = 9/10 (해제된 9/12 99,000 제외)
  assert.strictEqual(last.hi[0], 91000); assert.strictEqual(last.r, 1);
  assert.strictEqual(a.deals[2].cd, '2026-09-20'); assert.ok(!a.deals[2].r);                          // 해제일 표시, 해제는 신고가 아님
  assert.strictEqual(last.s, '2026-09-26');
  const b = dealRows(d, h, ['202609'], '2026-09-27', a.seen, a.seenX);                        // 다음 날 다시 빌드해도
  assert.strictEqual(b.deals[3].s, '2026-09-26');                                                 // 공개일은 그대로
  assert.strictEqual(dealRows(d, h, ['202609'], '2026-09-26', undefined).deals[3].s, undefined);    // 첫 수집 날은 기준선(공개일 없음)
}
assert.deepStrictEqual(jeonseMedian([[20260801, 50000, 3], [20260901, 60000, 5], [20260910, 90000, 7, 1], [20250101, 10000, 1]], 20260915), [55000, 2]); // 6개월·갱신 제외

// 홈 최근 신고가: 기본 상승률(이전 최고 대비) 높은 순, 같으면 최신 계약 먼저
{ const { REC_SORT, recCard } = require('./build.js');
  const R = (id, p, prev, d) => ['11', '서울 강남구', '11680', id, 84.9, '10', p, prev, '2026-01-02', d, '11680-1', '대치동', 2000, 0, [90000, 100000]];
  const L = [R('a', 110000, 100000, '2026-09-10'), R('b', 200000, 150000, '2026-09-01'), R('c', 220000, 200000, '2026-09-20'), R('d', 105000, 100000, '2026-09-25')];
  const ids = (k) => L.slice().sort(REC_SORT[k]).map((x) => x[3]).join('');
  assert.strictEqual(ids('rate'), 'bcad');                                                         // 33.3% > 10%(9/20) = 10%(9/10) > 5%
  assert.strictEqual(ids('amt'), 'bcad');
  assert.strictEqual(ids('new'), 'dcab');
  const h = recCard(L[1], 0, 't', 2026);
  assert.ok(h.includes('1위') && h.includes('<svg class="spark"') && h.includes('+33.3%') && h.includes('27년차') && h.includes('이전 최고가') && h.includes('/apt/11680-1/#a85'));
  const sec = require('./build.js').recSection({ t: L, r: [] }, { t: [], r: [] }, [], 2026);                     // 홈에 싣는 스크립트가 문법 오류 없이 파싱되는지
  new Function(sec.html.match(/<script>([\s\S]*)<\/script>/)[1]); assert.strictEqual(JSON.parse(sec.json).t.length, 4); }

// IndexNow: 사이트맵 lastmod == 오늘인 URL만, 색인 순서대로, 상한까지
{ const { changedUrls } = require('./indexnow.js'), os = require('os'), dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'inow-'));
  const u = (p, d) => `<url><loc>https://home.hanbogi.com${p}</loc><lastmod>${d}</lastmod></url>`;
  fs.writeFileSync(dir + '/sitemap.xml', '<sitemapindex><sitemap><loc>https://home.hanbogi.com/sitemap-main.xml</loc></sitemap><sitemap><loc>https://home.hanbogi.com/sitemap-apt-hot.xml</loc></sitemap></sitemapindex>');
  fs.writeFileSync(dir + '/sitemap-main.xml', [u('/', '2026-09-28'), u('/lh/', '2026-09-27')].join('\n'));
  fs.writeFileSync(dir + '/sitemap-apt-hot.xml', [u('/apt/1-1/', '2026-09-28'), u('/apt/1-2/', '2026-09-28')].join('\n'));
  assert.deepStrictEqual(changedUrls(dir, '2026-09-28'), ['https://home.hanbogi.com/', 'https://home.hanbogi.com/apt/1-1/', 'https://home.hanbogi.com/apt/1-2/']);
  assert.strictEqual(changedUrls(dir, '2026-09-28', 2).length, 2);
  fs.rmSync(dir, { recursive: true }); }

console.log('test.js: 모두 통과');
