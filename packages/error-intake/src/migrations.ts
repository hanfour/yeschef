export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS error_intake_meta (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    schema_version INT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS error_group (
    id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    project VARCHAR(50) NOT NULL,
    environment VARCHAR(20) NOT NULL,
    fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source ENUM('server','browser') NOT NULL,
    error_type VARCHAR(200) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    top_frame VARCHAR(500) NOT NULL,
    route VARCHAR(300) NULL,
    count INT UNSIGNED NOT NULL DEFAULT 1,
    first_seen_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL,
    status ENUM('new','in_progress','resolved','ignored') NOT NULL DEFAULT 'new',
    status_note VARCHAR(1000) NULL,
    resolved_at DATETIME(3) NULL,
    regressed_at DATETIME(3) NULL,
    UNIQUE KEY error_group_project_environment_fingerprint (project, environment, fingerprint),
    KEY error_group_status_last_seen (project, environment, status, last_seen_at),
    KEY error_group_project_environment_first_seen (project, environment, first_seen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS error_event (
    id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    group_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    stack TEXT NOT NULL,
    release_tag VARCHAR(100) NULL,
    user_agent VARCHAR(300) NULL,
    request_method VARCHAR(10) NULL,
    status_code SMALLINT NULL,
    KEY error_event_group_occurred (group_id, occurred_at),
    CONSTRAINT error_event_group_fk FOREIGN KEY (group_id) REFERENCES error_group (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `INSERT INTO error_intake_meta (id, schema_version) VALUES (1, ${SCHEMA_VERSION})
   ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version)`,
]);
