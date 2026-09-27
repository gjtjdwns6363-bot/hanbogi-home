#!/usr/bin/env node
// 신고가 비교용 과거 실거래 백필: 최근 36개월(최근 두 달은 build.js 몫)을 최신 달부터 채운다.
// 하루 API별 DAILY회까지만 쓰고 멈춘다. 채운 달은 history/<시군구>.json 의 m 에 남으므로 다음 날 이어서 한다.
//   DATA_GO_KR_KEY=... node backfill.js
'use strict';
const DAILY = +process.env.BACKFILL_DAILY || 8000;
process.env.CAP = String(DAILY); // build.js 프로세스 안 상한
const fs = require('fs');
const path = require('path');
const { rtms, calls, pool, putMonth, pruneHist, loadHist, saveHist, HIST } = require('./build.js');

const OPS = { t: 'RTMSDataSvcAptTradeDev', r: 'RTMSDataSvcAptRent' };
const kst = new Date(Date.now() + 9 * 3600e3), today = kst.toISOString().slice(0, 10);
const ym = (back) => new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - back, 1)).toISOString().slice(0, 7).replace('-', '');
const regions = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));
const bf = path.join(HIST, '_budget.json');
let budget = {}; try { budget = JSON.parse(fs.readFileSync(bf, 'utf8')); } catch {}
const base = budget.date === today ? budget : { t: 0, r: 0 };
const used = (k) => base[k] + (calls[OPS[k]] || 0);
const saveBudget = () => { fs.mkdirSync(HIST, { recursive: true }); fs.writeFileSync(bf, JSON.stringify({ date: today, t: used('t'), r: used('r') })); };

(async () => {
  if (!process.env.DATA_GO_KR_KEY) throw new Error('DATA_GO_KR_KEY 환경변수가 없어요');
  const cache = {}, hist = (c) => (cache[c] ||= loadHist(c));
  const from = ym(35);
  for (const r of regions) for (const k of ['t', 'r']) pruneHist(hist(r.code)[k], from);
  const tasks = [];
  for (let b = 2; b <= 35; b++) for (const r of regions) for (const k of ['t', 'r']) if (!hist(r.code)[k].m.includes(ym(b))) tasks.push({ r, k, ym: ym(b) });
  console.log(`[백필] 남은 작업 ${tasks.length}개 (시군구×달×종류), 오늘 이미 쓴 호출 매매 ${base.t}·전월세 ${base.r}, 하루 상한 API별 ${DAILY}`);
  let stop = '', done = 0, fail = 0, lastYm = '';
  await pool(tasks, +process.env.CONC || 3, async (t) => {
    if (stop || used(t.k) >= DAILY - 10) return; // 여러 쪽짜리 달이 있어 여유 10회
    try {
      const rows = await rtms(OPS[t.k], t.r.code, t.ym);
      putMonth(hist(t.r.code)[t.k], t.ym, t.k, rows);
      saveHist(t.r.code, hist(t.r.code));
      done++;
      if (t.ym !== lastYm) { lastYm = t.ym; console.log(`[백필] ${t.ym} 진행 · 호출 매매 ${used('t')}·전월세 ${used('r')}`); }
    } catch (e) {
      if (e.fatal) stop = e.message; else fail++;
    } finally { saveBudget(); }
  });
  saveBudget();
  const cov = regions.map((r) => Math.min(hist(r.code).t.m.length, hist(r.code).r.m.length) + 2);
  const left = tasks.length - done;
  console.log(`[백필] 이번 실행 ${done}개 완료, 실패 ${fail}, 남은 작업 ${left}개${stop ? ' · 중단: ' + stop : ''}`);
  console.log(`[백필] 확보 개월(최근 두 달 포함): 최소 ${Math.min(...cov)} · 최대 ${Math.max(...cov)} · 12개월 이상 ${cov.filter((c) => c >= 12).length}/${regions.length}곳`);
  console.log(`[백필] 오늘 호출: 매매 ${used('t')} · 전월세 ${used('r')}`);
})().catch((e) => { console.error('❌ 백필 실패:', e.message); process.exit(1); });
