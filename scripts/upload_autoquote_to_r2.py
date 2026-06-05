#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
자동견적 코퍼스 → R2(비공개 autoquote 버킷) 업로드.

올리는 것(백엔드 AutoQuoteDataSource/InvoiceEvidenceService 가 기대하는 이름 그대로):
  - priced_index.json              학습 인덱스(거래처별 가격라인)
  - easyform_*.json (참조된 8개)    과거 명세서 grid = 단가찾아보기 '근거'
  - easyform_<스템>_<idx>.png       그 명세서의 지시서 사진
                                    (groups.json 매핑, verified_pairs.json 로 덮어씀)

백엔드는 사진을 `<easyform파일스템>_<invoice_idx>.{jpg|jpeg|png}` 이름으로 찾는다.
R2 자격증명은 환경변수에서만 읽는다(스크립트에 비밀 없음):
  R2_ENDPOINT            예: https://<account_id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET              Railway 의 AUTOQUOTE_R2_BUCKET 과 동일
  R2_PREFIX              기본 autoquote/  (백엔드 autoquote.r2-prefix 기본값과 동일)

사용:
  pip install boto3
  # 먼저 미리보기(자격증명 불필요):
  python scripts/upload_autoquote_to_r2.py --dry-run
  # 실제 업로드(환경변수 설정 후):
  python scripts/upload_autoquote_to_r2.py --skip-existing
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

DEFAULT_DATA_DIR = r"C:\Users\USER\Desktop\hdsign\auto-quote-data"


def build_upload_list(data_dir):
    learning = os.path.join(data_dir, "learning")
    invoices = os.path.join(data_dir, "invoices")
    photos_dir = os.path.join(data_dir, "work-order-photos-sorted")

    prefix = os.environ.get("R2_PREFIX", "autoquote/")
    if not prefix.endswith("/"):
        prefix += "/"

    # 1) priced_index → 참조 (file, idx) 집합 + 참조 easyform 파일
    with open(os.path.join(learning, "priced_index.json"), encoding="utf-8") as f:
        pi = json.load(f)
    refs = set()
    ef_files = set()
    for _cl, rows in pi.get("by_client", {}).items():
        for r in rows:
            fl, idx = r.get("file"), r.get("idx")
            if fl is None or idx is None:
                continue
            refs.add((fl, str(idx)))
            ef_files.add(fl)

    # 2) (file, idx) → 대표 사진. groups.json 첫 후보(overlap 최상), verified_pairs.json 로 덮어씀.
    photo_map = {}
    with open(os.path.join(learning, "groups.json"), encoding="utf-8") as f:
        for e in json.load(f):
            ph = e.get("photos") or []
            if ph:
                photo_map[(e.get("invoice_file"), str(e.get("invoice_idx")))] = ph[0]["filename"]
    vp = os.path.join(learning, "verified_pairs.json")
    if os.path.exists(vp):
        with open(vp, encoding="utf-8") as f:
            for e in json.load(f):
                inv = e.get("invoice") or {}
                if e.get("filename"):
                    photo_map[(inv.get("file"), str(inv.get("invoice_idx")))] = e["filename"]

    uploads = []  # (local_path, r2_key, content_type)
    uploads.append((os.path.join(learning, "priced_index.json"), prefix + "priced_index.json", "application/json"))
    for fl in sorted(ef_files):
        p = os.path.join(invoices, fl)
        if os.path.exists(p):
            uploads.append((p, prefix + fl, "application/json"))
        else:
            print("  [경고] easyform 파일 없음:", fl)

    n_photo = n_missing = 0
    for (fl, idx) in sorted(refs):
        fn = photo_map.get((fl, idx))
        if not fn:
            n_missing += 1
            continue
        src = os.path.join(photos_dir, fn)
        if not os.path.exists(src):
            n_missing += 1
            continue
        stem = fl[:-5] if fl.endswith(".json") else fl
        ext = (os.path.splitext(fn)[1].lower().lstrip(".")) or "png"
        ct = "image/png" if ext == "png" else "image/jpeg"
        uploads.append((src, "%s%s_%s.%s" % (prefix, stem, idx, ext), ct))
        n_photo += 1

    print("참조 invoice %d건 · easyform %d파일 · 사진 %d장(매핑없음 %d) · 업로드 %d건"
          % (len(refs), len(ef_files), n_photo, n_missing, len(uploads)))
    return uploads, prefix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    ap.add_argument("--dry-run", action="store_true", help="목록만 출력(업로드 안 함, 자격증명 불필요)")
    ap.add_argument("--skip-existing", action="store_true", help="이미 있는 키는 건너뜀(이어올리기)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    uploads, prefix = build_upload_list(args.data_dir)

    if args.dry_run:
        for lp, k, _ct in uploads[:25]:
            print("   ", k, "<-", os.path.basename(lp))
        if len(uploads) > 25:
            print("    ... 외 %d건 (dry-run, 업로드 안 함)" % (len(uploads) - 25))
        return

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        print("boto3 필요: pip install boto3")
        sys.exit(1)

    missing = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
               if not os.environ.get(k)]
    if missing:
        print("환경변수 누락:", ", ".join(missing))
        sys.exit(1)

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )

    def put(job):
        lp, key, ct = job
        if args.skip_existing:
            try:
                s3.head_object(Bucket=bucket, Key=key)
                return ("skip", key)
            except Exception:
                pass
        s3.upload_file(lp, bucket, key, ExtraArgs={"ContentType": ct})
        return ("put", key)

    done = skipped = errors = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(put, j): j for j in uploads}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                kind, _key = fut.result()
                if kind == "put":
                    done += 1
                else:
                    skipped += 1
            except Exception as e:
                errors += 1
                print("  [실패]", futs[fut][1], "-", e)
            if i % 200 == 0:
                print("  ...%d/%d (put=%d skip=%d err=%d)" % (i, len(uploads), done, skipped, errors))

    print("완료: 업로드 %d · 건너뜀 %d · 실패 %d → %s/%s" % (done, skipped, errors, bucket, prefix))


if __name__ == "__main__":
    main()
