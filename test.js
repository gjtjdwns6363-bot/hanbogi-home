// node test.js — 핵심 순수 함수 검사
const assert = require('assert');
const fs = require('fs');
const { fmtWon, median, normDate, areaBand, parseRtms, toMan } = require('./build.js');

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

console.log('test.js: 모두 통과');
