#!/usr/bin/env node
// 배포 뒤 오늘 바뀐 URL(사이트맵 lastmod == 오늘 KST, 최대 10,000개)만 네이버·IndexNow에 알린다.
// 무슨 일이 있어도 exit 0 — 배포 결과와 무관. `--dry` = 보낼 URL 수만 출력
'use strict';
const fs = require('fs');
const path = require('path');
const KEY = 'e386846d4b6f939fd1b440af9728c599', HOST = 'home.hanbogi.com';
const ENDPOINTS = ['https://searchadvisor.naver.com/indexnow', 'https://api.indexnow.org/indexnow'];

function changedUrls(dist, today, cap = 10000) { // 색인 사이트맵 순서(main → regions → apt-hot → apt-rest) 그대로
  const idx = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  const files = [...idx.matchAll(/<loc>[^<]*\/(sitemap-[^<\/]+\.xml)<\/loc>/g)].map((m) => m[1]);
  return files.flatMap((f) => [...fs.readFileSync(path.join(dist, f), 'utf8').matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)]
    .filter((m) => m[2] === today).map((m) => m[1])).slice(0, cap);
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const urlList = changedUrls(path.join(__dirname, 'dist'), today);
  console.log(`IndexNow: ${today} 바뀐 URL ${urlList.length}개`);
  if (!urlList.length || process.argv.includes('--dry')) return;
  const keyLocation = `https://${HOST}/${KEY}.txt`;
  // GitHub Pages 반영을 기다린다: 키 파일이 보일 때까지 최대 5분 (새 페이지가 올라갈 시간도 겸함)
  await new Promise((r) => setTimeout(r, 60000));
  for (let i = 0; i < 16; i++) {
    const ok = await fetch(keyLocation, { signal: AbortSignal.timeout(15000) }).then((r) => r.text()).then((t) => t.trim() === KEY, () => false);
    if (ok) break;
    if (i === 15) return console.log('IndexNow: 키 파일이 아직 안 보여 이번엔 건너뜀');
    await new Promise((r) => setTimeout(r, 15000));
  }
  const body = JSON.stringify({ host: HOST, key: KEY, keyLocation, urlList });
  for (const u of ENDPOINTS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body, signal: AbortSignal.timeout(60000) });
      console.log(`IndexNow ${u}: HTTP ${r.status} ${(await r.text()).slice(0, 150).replace(/\s+/g, ' ')}`);
    } catch (e) { console.log(`IndexNow ${u}: 실패 ${e.message}`); }
  }
}

module.exports = { changedUrls };
if (require.main === module) main().catch((e) => console.log('IndexNow: 오류', e.message)).finally(() => process.exit(0));
