# autoquote/ — 런타임 프로비저닝 (커밋 금지)

이 디렉터리에는 자동견적 기밀 학습 데이터가 들어가지만 **git 에 절대 커밋하지 않는다**.
이 GitHub 저장소는 **PUBLIC** 이며 `corpus.json`(과거 명세서 코퍼스, ~4.7MB)·`priors.json`
(학습된 prior)은 **회사 기밀(명세서 원본 라인)** 이라 공개 호스팅이 금지된다(Iron Law).

## 서빙 방식 (slice-6: 파일시스템 + R2 layered)

`AdminAutoQuoteController` 는 이 파일들을 classpath 가 아니라 **런타임**에 두 소스 중 하나에서
순서대로 읽는다:

1. **파일시스템** — `autoquote.data-dir`(env `AUTOQUOTE_DATA_DIR`) 가 설정돼 있고
   `<dir>/{corpus,priors}.json` 이 읽기 가능하면 거기서 읽는다(slice-5 경로, 우선).
2. **Cloudflare R2 (전용 비공개 버킷)** — data-dir 가 미설정/부재이고
   `autoquote.r2-bucket`(env `AUTOQUOTE_R2_BUCKET`) 이 설정돼 있으면, 다른 기능과 공유하는
   기존 `S3Client` 빈(`R2Config`)으로 `<r2-prefix><name>` 객체를 받아 읽는다.
   프리픽스 기본값은 `autoquote/` (`autoquote.r2-prefix`).
   **공유 공개 버킷 `r2.bucket`(`hdsign-gallery`)으로 폴백하지 않는다.**

> ⚠️ **절대 공개 갤러리 버킷에 기밀 코퍼스를 두지 말 것.**
> 공유 `r2.bucket`(`hdsign-gallery`)은 갤러리 이미지를 `*.r2.dev` **공개 URL** 로 서빙하기 위해
> **Public Access 가 켜져** 있다. 그 버킷에 `autoquote/corpus.json` 을 올리면
> `https://pub-….r2.dev/autoquote/corpus.json` 로 누구나 HTTP 200 다운로드가 가능해져
> **회사 기밀이 유출된다**(실측 확인됨). 그래서 자동견적 코퍼스/prior 는 반드시
> **Public Access 가 꺼진 별도 비공개 버킷**에서 읽는다.

### 환경별 설정

- **로컬/통합테스트(bootRun, e2e)**: `auto-quote-data/autoquote/{corpus,priors}.json`
  (gitignore 된 개인 PC 데이터 홈). `application-autoquote-it.properties` 에서
  `autoquote.data-dir` 절대경로로 지정한다. 실 R2 자격증명 없이도 동작한다.
- **운영(Railway, R2 사용 — 권장)**: `AUTOQUOTE_DATA_DIR` 를 **설정하지 않는다**(→ R2 사용).
  1. Cloudflare R2 에 **전용 비공개 버킷**(예: `hdsign-autoquote`)을 새로 만든다.
     **Public Access 를 끈다**(r2.dev 공개 URL 비활성). 공개 `hdsign-gallery` 를 재사용하지 않는다.
  2. `AUTOQUOTE_R2_BUCKET` 를 그 **비공개** 버킷 이름으로 설정한다(공개 `R2_BUCKET` 값이 **아님**).
  3. 기존 R2 API 토큰(`R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_ENDPOINT` — 공유)이 그 비공개 버킷에
     접근 가능한지 확인한다(토큰 권한에 새 버킷 포함).
  4. `corpus.json`·`priors.json` 을 그 비공개 버킷의 `autoquote/` 프리픽스 아래에 업로드한다.
  (별도 영구 볼륨 불필요. `AUTOQUOTE_DATA_DIR` 는 운영에서 **미설정**으로 둔다.)

R2 객체가 없거나(NoSuchKey) S3/SDK 오류·자격증명 누락이거나 두 소스 모두 미설정이면 엔드포인트는
**503 `{"error":"autoquote_data_unavailable"}`** 로 graceful 하게 응답한다(500/stacktrace 없음,
R2 비밀·원본 예외 비노출, 미스는 캐시하지 않음). admin JWT 는 항상 필요하다. 성공 응답에는
내용 SHA-256 강한 ETag 가 붙어 `If-None-Match` → 304 로 캐시된다(소스 무관).

`.gitignore` 가 `backend/src/main/resources/autoquote/*.json` 를 차단하므로 실수로 이 위치에
실데이터를 떨어뜨려도 추적되지 않는다. 테스트는 `src/test/resources/autoquote-fixtures/` 의
**작은 가짜 픽스처**만 사용하며 실데이터를 참조하지 않는다.
