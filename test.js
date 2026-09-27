// node test.js — 핵심 순수 함수 검사
const assert = require('assert');
const fs = require('fs');
const { fmtWon, median, normDate, areaBand, parseRtms, toMan, recKey, putMonth, findRecords, emptyHist } = require('./build.js');

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

console.log('test.js: 모두 통과');
