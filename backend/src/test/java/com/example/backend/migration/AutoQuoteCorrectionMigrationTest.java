package com.example.backend.migration;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Types;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * @slice-3 V13__add_autoquote_corrections.sql 의 단독(isolated) 유효성 검증.
 *
 * <p>V13 SQL 한 장을 H2(MySQL 모드) 인메모리 DB 에 직접 실행해, autoquote_correction 테이블과
 * feature_key 인덱스가 스펙대로(컬럼/타입) 생성되는지 JDBC 메타데이터로 확인한다. Spring 컨텍스트
 * 없이 순수 JDBC 라 빠르고 결정적이다.
 *
 * <p><b>주의</b>: 이 테스트는 V13 한 장만 검증한다. V1..V13 전체 체인 검증은 실제 MySQL
 * (혹은 Testcontainers) 이 필요하다 — 운영 마이그레이션은 MySQL 전용 문법(MODIFY COLUMN 등)을
 * 쓰므로 H2 에서 통째로 돌릴 수 없고, CI 에는 MySQL/Docker 가 없다. 그렇다고 기존 마이그레이션을
 * H2 호환으로 약화시키지 않는다(운영 무결성 우선). 여기서는 새로 추가한 V13 만 격리 검증한다.
 */
class AutoQuoteCorrectionMigrationTest {

    private static final String V13 = "db/migration/V13__add_autoquote_corrections.sql";

    private String loadSql() throws Exception {
        try (var in = new ClassPathResource(V13).getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void v13_createsAutoquoteCorrectionTable_withFeatureKeyIndex_andSpecColumns() throws Exception {
        String sql = loadSql();

        // 운영 데이터소스(application-autoquote-it.properties)와 동일한 H2 MySQL 모드로 격리 실행.
        String url = "jdbc:h2:mem:v13_validity;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        try (Connection conn = DriverManager.getConnection(url, "sa", "");
             Statement st = conn.createStatement()) {

            // V13 한 장을 그대로 실행 — 파싱/DDL 적용이 성공해야 한다(MySQL 호환 문법 확인).
            st.execute(sql);

            DatabaseMetaData meta = conn.getMetaData();

            // 1) 테이블 존재.
            assertThat(tableExists(meta, "autoquote_correction"))
                    .as("autoquote_correction table must be created by V13")
                    .isTrue();

            // 2) 스펙 컬럼 + 타입 확인.
            Map<String, ColumnInfo> cols = columns(meta, "autoquote_correction");
            assertThat(cols.keySet()).contains(
                    "id", "feature_key", "corrected_unit_price",
                    "explanation", "author", "priority", "created_at");

            // id BIGINT
            assertThat(cols.get("id").sqlType).isEqualTo(Types.BIGINT);

            // feature_key VARCHAR(255) NOT NULL
            assertThat(cols.get("feature_key").sqlType).isEqualTo(Types.VARCHAR);
            assertThat(cols.get("feature_key").size).isEqualTo(255);
            assertThat(cols.get("feature_key").nullable).isFalse();

            // corrected_unit_price DECIMAL(12,2) NOT NULL
            assertThat(cols.get("corrected_unit_price").sqlType)
                    .isIn(Types.DECIMAL, Types.NUMERIC);
            assertThat(cols.get("corrected_unit_price").size).isEqualTo(12);
            assertThat(cols.get("corrected_unit_price").decimalDigits).isEqualTo(2);
            assertThat(cols.get("corrected_unit_price").nullable).isFalse();

            // explanation TEXT NOT NULL (H2 maps TEXT -> CLOB/char large object)
            assertThat(cols.get("explanation").sqlType)
                    .as("explanation should be a character/large-object type")
                    .isIn(Types.CLOB, Types.LONGVARCHAR, Types.VARCHAR, Types.CHAR);
            assertThat(cols.get("explanation").nullable).isFalse();

            // author VARCHAR(128) NOT NULL
            assertThat(cols.get("author").sqlType).isEqualTo(Types.VARCHAR);
            assertThat(cols.get("author").size).isEqualTo(128);
            assertThat(cols.get("author").nullable).isFalse();

            // priority INT NOT NULL
            assertThat(cols.get("priority").sqlType).isEqualTo(Types.INTEGER);
            assertThat(cols.get("priority").nullable).isFalse();

            // created_at DATETIME NOT NULL
            assertThat(cols.get("created_at").sqlType).isIn(Types.TIMESTAMP);
            assertThat(cols.get("created_at").nullable).isFalse();

            // 3) feature_key 인덱스 존재.
            assertThat(hasIndexOnColumn(meta, "autoquote_correction", "feature_key"))
                    .as("V13 must create an index on feature_key")
                    .isTrue();
        }
    }

    // ---- JDBC metadata helpers -------------------------------------------

    private static boolean tableExists(DatabaseMetaData meta, String table) throws Exception {
        try (ResultSet rs = meta.getTables(null, null, null, new String[]{"TABLE"})) {
            while (rs.next()) {
                if (table.equalsIgnoreCase(rs.getString("TABLE_NAME"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Map<String, ColumnInfo> columns(DatabaseMetaData meta, String table) throws Exception {
        Map<String, ColumnInfo> out = new HashMap<>();
        try (ResultSet rs = meta.getColumns(null, null, null, null)) {
            while (rs.next()) {
                if (!table.equalsIgnoreCase(rs.getString("TABLE_NAME"))) {
                    continue;
                }
                ColumnInfo ci = new ColumnInfo();
                ci.sqlType = rs.getInt("DATA_TYPE");
                ci.size = rs.getInt("COLUMN_SIZE");
                ci.decimalDigits = rs.getInt("DECIMAL_DIGITS");
                ci.nullable = rs.getInt("NULLABLE") == DatabaseMetaData.columnNullable;
                out.put(rs.getString("COLUMN_NAME").toLowerCase(), ci);
            }
        }
        return out;
    }

    private static boolean hasIndexOnColumn(DatabaseMetaData meta, String table, String column) throws Exception {
        Set<String> indexedFirstColumns = new HashSet<>();
        // getIndexInfo 는 대소문자 구분 — 실제 저장된 표기를 찾아 넘긴다.
        String actualTable = actualTableName(meta, table);
        try (ResultSet rs = meta.getIndexInfo(null, null, actualTable, false, false)) {
            while (rs.next()) {
                String col = rs.getString("COLUMN_NAME");
                if (col != null) {
                    indexedFirstColumns.add(col.toLowerCase());
                }
            }
        }
        return indexedFirstColumns.contains(column.toLowerCase());
    }

    private static String actualTableName(DatabaseMetaData meta, String table) throws Exception {
        try (ResultSet rs = meta.getTables(null, null, null, new String[]{"TABLE"})) {
            while (rs.next()) {
                String name = rs.getString("TABLE_NAME");
                if (table.equalsIgnoreCase(name)) {
                    return name;
                }
            }
        }
        return table;
    }

    private static final class ColumnInfo {
        int sqlType;
        int size;
        int decimalDigits;
        boolean nullable;
    }
}
