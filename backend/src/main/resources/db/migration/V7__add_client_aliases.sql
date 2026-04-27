-- 거래처 가입 검색 유사도 보강용 별칭 컬럼.
-- 콤마 구분 문자열로 보관 (예: "디자인H, dH"). 검색 시 자모 거리 풀에 포함된다.
ALTER TABLE client_users ADD COLUMN aliases VARCHAR(500) NULL;
