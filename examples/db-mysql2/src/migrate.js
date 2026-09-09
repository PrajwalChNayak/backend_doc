import { pathToFileURL } from 'node:url'
import { pool, connectionHelp } from './db.js'

// DDL cannot be a prepared statement in MySQL, so these go through pool.query().
// They contain no user input — they are constants in this file.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     email      VARCHAR(255) NOT NULL,
     name       VARCHAR(120) NOT NULL,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY users_email_key (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS posts (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     user_id    BIGINT UNSIGNED NOT NULL,
     title      VARCHAR(200) NOT NULL,
     body       TEXT         NOT NULL,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY posts_user_id_idx (user_id),
     CONSTRAINT posts_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
]

export async function migrate() {
  for (const statement of STATEMENTS) {
    await pool.query(statement)
  }
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (runDirectly) {
  try {
    await migrate()
    console.log('migrated')
  } catch (err) {
    console.error(connectionHelp(err))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
