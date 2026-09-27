# 부동산 알리미 (home.hanbogi.com)

공공데이터로 매일 05:00 KST에 다시 만드는 정적 사이트. GitHub Actions(`.github/workflows/build.yml`)가 `node build.js`로 `dist/`를 만들어 GitHub Pages에 배포한다. 생성물은 커밋하지 않는다.

- `node build.js` — 실제 API 호출 (env `DATA_GO_KR_KEY` = 공공데이터포털 **디코딩** 키, 저장소 시크릿)
- `node build.js --fixtures` — `fixtures/`의 샘플 응답으로 생성 (키 불필요)
- `node test.js` — 가격 표시·중위값·날짜 파싱·XML 파서·신고가 판정 검사 · 홈 신고가 정렬(상승률순, 같으면 최신)
- `node build.js --from-cache` — API 호출 없이 마지막 실제 빌드가 남긴 원자료 `history/_raw.json`(실거래·청약·LH, 매 실제 빌드가 덮어씀)으로 다시 그린다. 저장소(history/)는 건드리지 않는다. `RAW_CACHE=경로`로 다른 파일 지정 가능
- `node backfill.js` — 신고가 비교용 과거 36개월 실거래를 `history/`(git 제외, 이 맥에만 있음)에 채운다. 최신 달부터, 하루 API별 8,000회까지만 쓰고 멈추며 다음 실행 때 이어서 한다. `deploy_local.sh`가 매일 배포 뒤 자동 실행.

## 신고가·오늘 실거래가
- 키: `aptSeq|전용면적(㎡ 반올림)`. 신고가 = 같은 키에서 **계약일이 더 이른** 거래(최대 36개월)의 최고가보다 비싼 거래. 이전 거래가 없으면(첫 거래) 신고가 아님. 매매는 해제(cdealType=O), 전세는 월세(monthlyRent>0) 제외.
- 저장소 `history/<시군구>.json`: 매매·전세별 채운 달 목록과 키별 `[계약일, 만원, 층(, 갱신=1)]` 목록, 거래를 처음 본 날 `seen`·해제를 처음 본 날 `seenX`(한 번 정하면 고정). 매일 빌드가 최근 두 달을 덮어쓴다. `history/_pages.json` = 페이지별 내용 해시와 마지막 변경일(사이트맵 lastmod), `history/reports/` = 날짜별 리포트 본문.
- 12개월 이상 모인 시군구만 홈 “최근 신고가”에 나온다. 자료는 빌드 때 `dist/data/rec.json`(카드·월별 중위가 스파크라인)으로 따로 내보내고, 홈은 기본 상승률순 카드 20장씩 그린다(상승액순·최신 계약순 선택). 그 전엔 “과거 데이터 수집 중(최근 N개월 기준)” 표시.
- 페이지: `/r/<시군구>/`(+`high/ up/ down/ rent/ monthly/ cancel/ week/ month/`) 오늘 공개된 거래 카드(HTML에 전부, `today.js`는 거르기·정렬·50건씩만), `/r/<시도>/`, `/today/` 모음, `/apt/<aptSeq>/` 단지 상세(면적별 요약·SVG 차트·이력), `/report/<날짜>/` 날짜별 리포트. 기존 `/apt/<시군구>/` 두 달 거래표도 그대로 둔다.
- 사이트맵: `sitemap.xml`(색인) → `sitemap-main.xml`, `sitemap-regions.xml`, `sitemap-apt-N.xml`(5만 개씩).
- 설계 참고: `벤치마킹_하우스랭킹.md` (git 제외)

## 데이터
| 자료 | 엔드포인트 | 명세 |
|---|---|---|
| 아파트 매매 실거래가 상세 | `apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev` (XML) | https://www.data.go.kr/data/15126468/openapi.do |
| 아파트 전월세 실거래가 | `apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent` (XML) | https://www.data.go.kr/data/15126474/openapi.do |
| 청약홈 APT 분양정보 상세 / 주택형별 | `api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`, `.../getAPTLttotPblancMdl` (JSON) | https://www.data.go.kr/data/15098547/openapi.do |
| LH 분양임대공고문 조회 | `apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1` (JSON) | https://www.data.go.kr/data/15058530/openapi.do (활용가이드 docx 20260708) |

`regions.json` (시군구 255곳) 출처: 국토교통부_전국 법정동 (https://www.data.go.kr/data/15063424/fileData.do, 2026-06-09 판) CSV에서 `법정동코드`가 `xxxxx00000`이고 시군구명이 있는 행의 앞 5자리. 구가 있는 시(예: 수원시 41110)는 빼고 구 코드(41111 등)만 남겼다. 법정동 개편 시 같은 방식으로 다시 만든다.

## 하루 호출 수 (대략)
- 실거래 매매·전월세: 255곳 × 2개월 × 1~2쪽 → API별 약 510~600회
- 백필(36개월이 다 찰 때까지): API별 하루 최대 8,000회
- 청약홈: 목록 1회 + 공고별 주택형 약 50~150회
- LH: 1~2회
API별 1회 실행 상한 4,000회(`CAP`), 일일 한도 10,000회.
