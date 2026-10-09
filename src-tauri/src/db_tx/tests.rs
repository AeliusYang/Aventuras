use super::{run_statements, TxStatement};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Row, SqlitePool};
use std::path::PathBuf;

struct TemporaryDatabase {
    directory: PathBuf,
}

impl TemporaryDatabase {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("airp-native-transaction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        Self { directory }
    }

    async fn open(&self) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(self.directory.join("aventura.db"))
                    .create_if_missing(true)
                    .foreign_keys(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .unwrap()
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        for file in ["aventura.db", "aventura.db-wal", "aventura.db-shm"] {
            let _ = std::fs::remove_file(self.directory.join(file));
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn fixture_batch(key: &str) -> Vec<TxStatement> {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/collaborative-truncation.json")).unwrap();
    serde_json::from_value(fixture[key].clone()).unwrap()
}

async fn fixture_database() -> (TemporaryDatabase, SqlitePool) {
    let database = TemporaryDatabase::new();
    let pool = database.open().await;
    let registration = include_str!("../lib.rs");
    let mut migration_count = 0;
    for declaration in registration
        .split("sql: include_str!(\"../migrations/")
        .skip(1)
    {
        let filename = declaration.split('"').next().unwrap();
        assert!(!filename.contains('/') && !filename.contains('\\'));
        let sql = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("migrations")
                .join(filename),
        )
        .unwrap();
        sqlx::raw_sql(AssertSqlSafe(sql.as_str()))
            .execute(&pool)
            .await
            .unwrap_or_else(|error| panic!("migration {filename}: {error}"));
        migration_count += 1;
    }
    assert!(migration_count >= 38);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::raw_sql(
        r#"
        INSERT INTO stories (id, title, created_at, updated_at, settings)
        VALUES ('story-fixture', '协作测试', 1, 1, '{}'), ('story-other', '其他故事', 1, 1, '{}');
        INSERT INTO branches (id, story_id, name, fork_entry_id, created_at, snapshot_complete)
        VALUES ('branch-a', 'story-fixture', '当前分支', 'root', 1, 1),
               ('branch-b', 'story-fixture', '另一分支', 'root', 1, 1);
        UPDATE stories SET current_branch_id = 'branch-a' WHERE id = 'story-fixture';
        INSERT INTO story_entries (id, story_id, type, content, position, created_at, branch_id, metadata)
        VALUES ('root', 'story-fixture', 'narration', '主线开场', 0, 1, NULL, '{}'),
               ('kept', 'story-fixture', 'narration', '已保存正文，不得改写', 1, 1, 'branch-a', '{}'),
               ('removed', 'story-fixture', 'narration', '待撤销正文', 2, 1, 'branch-a', '{}'),
               ('sibling', 'story-fixture', 'narration', '另一分支正文', 2, 1, 'branch-b', '{}'),
               ('external', 'story-other', 'narration', '其他故事正文', 2, 1, NULL, '{}');
        INSERT INTO characters (id, story_id, name, relationship, traits, branch_id)
        VALUES ('char-a', 'story-fixture', '当前人物', '当前关系', '[]', 'branch-a'),
               ('char-b', 'story-fixture', '另一分支人物', '另一关系', '[]', 'branch-b'),
               ('char-root', 'story-fixture', '主线原人物', '主线关系', '[]', NULL);
        INSERT INTO locations (id, story_id, name, current, branch_id)
        VALUES ('loc-a', 'story-fixture', '当前位置', 0, 'branch-a'),
               ('loc-new-a', 'story-fixture', '后来位置', 1, 'branch-a'),
               ('loc-b', 'story-fixture', '其他分支位置', 1, 'branch-b');
        INSERT INTO items (id, story_id, name, quantity, location, branch_id)
        VALUES ('item-a', 'story-fixture', '当前物品', 3, '已改变的位置', 'branch-a'),
               ('item-created-a', 'story-fixture', '新增物品', 1, '桌上', 'branch-a');
        INSERT INTO story_beats (id, story_id, title, status, branch_id)
        VALUES ('beat-a', 'story-fixture', '当前线程', 'completed', 'branch-a');
        INSERT INTO checkpoints (id, story_id, name, last_entry_id, entry_count,
          entries_snapshot, characters_snapshot, locations_snapshot, items_snapshot,
          story_beats_snapshot, chapters_snapshot, created_at, branch_id)
        VALUES ('checkpoint-a', 'story-fixture', '当前存档', 'removed', 3,
          '[]', '[]', '[]', '[]', '[]', '[]', 1, 'branch-a'),
          ('checkpoint-b', 'story-fixture', '另一存档', 'sibling', 3,
          '[]', '[]', '[]', '[]', '[]', '[]', 1, 'branch-b');
        INSERT INTO chapters (id, story_id, number, start_entry_id, end_entry_id,
          entry_count, summary, created_at, branch_id)
        VALUES ('chapter-a', 'story-fixture', 1, 'kept', 'removed', 2, '当前摘要', 1, 'branch-a'),
               ('chapter-b', 'story-fixture', 1, 'sibling', 'sibling', 1, '另一摘要', 1, 'branch-b');
        INSERT INTO world_state_snapshots (id, story_id, branch_id, entry_id, entry_position,
          characters_snapshot, locations_snapshot, items_snapshot, story_beats_snapshot, created_at)
        VALUES ('snapshot-a', 'story-fixture', 'branch-a', 'removed', 2, '[]', '[]', '[]', '[]', 1),
               ('snapshot-b', 'story-fixture', 'branch-b', 'sibling', 2, '[]', '[]', '[]', '[]', 1);
        INSERT INTO embedded_images (id, story_id, entry_id, source_text, prompt,
          style_id, model, created_at)
        VALUES ('image-a', 'story-fixture', 'removed', '', '', '', '', 1),
               ('image-b', 'story-fixture', 'sibling', '', '', '', '', 1);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    (database, pool)
}

async fn state_fingerprint(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
    let mut snapshots = Vec::new();
    for table in [
        "stories",
        "branches",
        "story_entries",
        "characters",
        "locations",
        "items",
        "story_beats",
        "checkpoints",
        "chapters",
        "world_state_snapshots",
        "embedded_images",
    ] {
        let schema_query = format!("PRAGMA table_info({table})");
        let columns = sqlx::query(AssertSqlSafe(schema_query.as_str()))
            .fetch_all(pool)
            .await
            .unwrap();
        let fields = columns
            .iter()
            .map(|column| {
                let name: String = column.get("name");
                format!("'{name}',\"{name}\"")
            })
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT json_object({fields}) FROM {table} ORDER BY id");
        let rows: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
            .fetch_all(pool)
            .await
            .unwrap();
        snapshots.push((table.to_string(), rows));
    }
    snapshots
}

async fn protected_fingerprint(pool: &SqlitePool) -> Vec<(String, String)> {
    let mut protected = Vec::new();
    for (table, rows) in state_fingerprint(pool).await {
        for serialized in rows {
            let row: Value = serde_json::from_str(&serialized).unwrap();
            if row["branch_id"] == "branch-b"
                || row["story_id"] == "story-other"
                || row["id"] == "story-other"
                || row["id"] == "branch-b"
                || row["id"] == "root"
                || row["id"] == "char-root"
                || row["entry_id"] == "sibling"
            {
                protected.push((table.clone(), serialized));
            }
        }
    }
    protected
}

#[tokio::test]
async fn frontend_batch_commits_and_survives_reopen_without_touching_other_branches() {
    let (database, pool) = fixture_database().await;
    let protected_before = protected_fingerprint(&pool).await;
    let batch = fixture_batch("statements");
    let affected = run_statements(&pool, &batch).await.unwrap();
    assert_eq!(affected.len(), batch.len());
    pool.close().await;
    let reopened = database.open().await;
    assert_eq!(protected_fingerprint(&reopened).await, protected_before);
    let prose: Vec<(String, String)> =
        sqlx::query_as("SELECT id, content FROM story_entries ORDER BY id")
            .fetch_all(&reopened)
            .await
            .unwrap();
    assert_eq!(prose.len(), 4);
    assert!(prose.contains(&("kept".into(), "已保存正文，不得改写".into())));
    assert!(prose.contains(&("sibling".into(), "另一分支正文".into())));
    assert!(prose.contains(&("external".into(), "其他故事正文".into())));
    let characters: Vec<(String, String)> =
        sqlx::query_as("SELECT id, relationship FROM characters ORDER BY id")
            .fetch_all(&reopened)
            .await
            .unwrap();
    assert!(characters.contains(&("char-a".into(), "合作但有保留".into())));
    assert!(characters.contains(&("char-b".into(), "另一关系".into())));
    assert!(characters.contains(&("char-root".into(), "主线关系".into())));
    let metadata: String =
        sqlx::query_scalar("SELECT metadata FROM characters WHERE id = 'char-a'")
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&metadata).unwrap(),
        json!({"source":"正文","uncertain":true})
    );
    for table in [
        "checkpoints",
        "chapters",
        "world_state_snapshots",
        "embedded_images",
    ] {
        let sql = format!("SELECT id FROM {table}");
        let ids: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
            .fetch_all(&reopened)
            .await
            .unwrap();
        assert_eq!(ids.len(), 1, "{table}");
        assert!(ids[0].ends_with("-b"), "{table}");
    }
    let time: String =
        sqlx::query_scalar("SELECT time_tracker FROM stories WHERE id = 'story-fixture'")
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&time).unwrap(),
        json!({"years":0,"days":1,"hours":2,"minutes":3})
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT location FROM items WHERE id = 'item-a'")
            .fetch_one(&reopened)
            .await
            .unwrap(),
        "工作台"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM story_beats WHERE id = 'beat-a'")
            .fetch_one(&reopened)
            .await
            .unwrap(),
        "active"
    );
    let item_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM items WHERE id = 'item-created-a'")
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert_eq!(item_count, 0);
    let locations: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, current FROM locations WHERE branch_id = 'branch-a' ORDER BY id",
    )
    .fetch_all(&reopened)
    .await
    .unwrap();
    assert_eq!(
        locations,
        vec![("loc-a".into(), 1), ("loc-new-a".into(), 0)]
    );
    let (settings, updated_at): (String, i64) =
        sqlx::query_as("SELECT settings, updated_at FROM stories WHERE id = 'story-fixture'")
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert_eq!(updated_at, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&settings).unwrap(),
        json!({"collaborativeNovelPattern":{"confirmed":"允许自主行动","needsReview":true}})
    );
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&reopened)
        .await
        .unwrap();
    assert!(violations.is_empty());
    reopened.close().await;
}

#[tokio::test]
async fn final_scope_mismatch_rolls_back_all_entity_and_history_changes() {
    let (database, pool) = fixture_database().await;
    sqlx::query("UPDATE stories SET current_branch_id = 'branch-b' WHERE id = 'story-fixture'")
        .execute(&pool)
        .await
        .unwrap();
    let before = state_fingerprint(&pool).await;
    let error = run_statements(&pool, &fixture_batch("statements"))
        .await
        .unwrap_err();
    assert!(error.contains("expected 1 affected rows, got 0"));
    pool.close().await;
    let reopened = database.open().await;
    assert_eq!(state_fingerprint(&reopened).await, before);
    reopened.close().await;
}

#[tokio::test]
async fn sql_error_rolls_back_successful_prior_statements() {
    let (database, pool) = fixture_database().await;
    let before = state_fingerprint(&pool).await;
    let mut batch = fixture_batch("statements");
    batch.push(TxStatement {
        sql: "INSERT INTO missing_test_table VALUES (?)".into(),
        params: vec![json!("error")],
        expected_rows: None,
    });
    let error = run_statements(&pool, &batch).await.unwrap_err();
    assert!(error.contains("transaction rolled back"));
    pool.close().await;
    let reopened = database.open().await;
    assert_eq!(state_fingerprint(&reopened).await, before);
    reopened.close().await;
}

#[tokio::test]
async fn rejected_json_bindings_do_not_commit_partial_batches() {
    let (_database, pool) = fixture_database().await;
    let before = state_fingerprint(&pool).await;
    for invalid in [json!({"nested":true}), json!([1]), json!(u64::MAX)] {
        let mut batch = fixture_batch("statements");
        batch.push(TxStatement {
            sql: "UPDATE stories SET title = ? WHERE id = 'story-fixture'".into(),
            params: vec![invalid],
            expected_rows: Some(1),
        });
        assert!(run_statements(&pool, &batch).await.is_err());
        assert_eq!(state_fingerprint(&pool).await, before);
    }
    pool.close().await;
}

#[tokio::test]
async fn main_branch_null_scope_is_exact_and_wrong_named_branch_fails() {
    let (_database, pool) = fixture_database().await;
    let mut batch = fixture_batch("mainStatements");
    run_statements(&pool, &batch).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT name FROM characters WHERE id = 'char-root'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "主线人物"
    );
    let before = state_fingerprint(&pool).await;
    *batch[0].params.last_mut().unwrap() = json!("branch-a");
    assert!(run_statements(&pool, &batch)
        .await
        .unwrap_err()
        .contains("got 0"));
    assert_eq!(state_fingerprint(&pool).await, before);
    pool.close().await;
}

#[tokio::test]
async fn explicit_zero_rows_and_empty_batches_do_not_fail() {
    let (_database, pool) = fixture_database().await;
    assert!(run_statements(&pool, &[]).await.unwrap().is_empty());
    let statement = TxStatement {
        sql: "DELETE FROM items WHERE id = ?".into(),
        params: vec![json!("does-not-exist")],
        expected_rows: Some(0),
    };
    assert_eq!(run_statements(&pool, &[statement]).await.unwrap(), vec![0]);
    pool.close().await;
}
