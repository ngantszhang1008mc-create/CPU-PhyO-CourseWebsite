type Binding = string | number | ArrayBuffer | null;

export interface Database {
  all<T extends object>(query: string, ...bindings: Binding[]): T[];
  write(query: string, ...bindings: Binding[]): void;
  atomic<T>(action: () => T): T;
}

export function initialize(db: Database, legacyPrimaryUsername?: string) {
  db.write(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','admin')))`);
  db.write(`CREATE TABLE IF NOT EXISTS invites (
    digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER CHECK(expires IS NOT NULL OR role='student'),
    issuance TEXT NOT NULL DEFAULT '')`);
  db.atomic(() => {
    const inviteColumns = db.all<{ name: string; notnull: number }>('PRAGMA table_info(invites)');
    if (!inviteColumns.some((column) => column.name === 'issuance')) {
      db.write("ALTER TABLE invites ADD COLUMN issuance TEXT NOT NULL DEFAULT ''");
    }
    if (!inviteColumns.some((column) => column.name === 'student_email')) {
      db.write('ALTER TABLE invites ADD COLUMN student_email TEXT');
    }
    if (inviteColumns.some((column) => column.name === 'expires' && column.notnull)) {
      // SQLite requires a table rebuild to make the expiry nullable. Keep existing deadlines.
      db.write(`CREATE TABLE invites_new (
        digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER CHECK(expires IS NOT NULL OR role='student'),
        issuance TEXT NOT NULL DEFAULT '', student_email TEXT)`);
      db.write(`INSERT INTO invites_new (rowid,digest,role,expires,issuance,student_email)
        SELECT rowid,digest,role,expires,issuance,student_email FROM invites`);
      db.write('DROP TABLE invites');
      db.write('ALTER TABLE invites_new RENAME TO invites');
    }
    const columns = db.all<{ name: string }>('PRAGMA table_info(users)').map((row) => row.name);
    if (!columns.includes('recovery_email'))
      db.write('ALTER TABLE users ADD COLUMN recovery_email TEXT');
    if (!columns.includes('reset_requested'))
      db.write('ALTER TABLE users ADD COLUMN reset_requested INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('active')) {
      db.write(
        'ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))',
      );
    }
    if (!columns.includes('version')) {
      db.write("ALTER TABLE users ADD COLUMN version TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.includes('is_primary')) {
      db.write(`ALTER TABLE users ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
        CHECK(is_primary=0 OR (is_primary=1 AND role='admin' AND active=1))`);
      // Older invitations have no issuer, so their authority to grant admin access is unknown.
      db.write("DELETE FROM invites WHERE role='admin'");
    }
    db.write(
      'CREATE UNIQUE INDEX IF NOT EXISTS users_one_primary ON users(is_primary) WHERE is_primary=1',
    );
    if (legacyPrimaryUsername) {
      // SQLite rowid 1 was the first bootstrap insertion. Never choose the next surviving admin.
      db.write(
        `UPDATE users SET is_primary=1, version=lower(hex(randomblob(32)))
        WHERE rowid=1 AND username=? AND role='admin' AND active=1
          AND NOT EXISTS (SELECT 1 FROM users WHERE is_primary=1)`,
        legacyPrimaryUsername,
      );
    }
    db.write("UPDATE users SET version=lower(hex(randomblob(32))) WHERE version=''");
  });
  db.write(`CREATE TABLE IF NOT EXISTS sessions (
    digest TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL)`);
  db.write(`CREATE TABLE IF NOT EXISTS password_resets (
    digest TEXT PRIMARY KEY, username TEXT NOT NULL, version TEXT NOT NULL, created INTEGER NOT NULL)`);
  db.write('CREATE INDEX IF NOT EXISTS resets_user ON password_resets(username,created)');
  db.write('CREATE INDEX IF NOT EXISTS resets_age ON password_resets(created)');
  db.write('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires)');
  db.write('CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires)');
  db.write(
    "CREATE INDEX IF NOT EXISTS invites_student_email ON invites(student_email) WHERE role='student'",
  );
  db.write(
    'CREATE TABLE IF NOT EXISTS classroom_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  db.write(`CREATE TABLE IF NOT EXISTS signup_challenges (
    digest TEXT PRIMARY KEY, invite_digest TEXT NOT NULL, issuance TEXT NOT NULL,
    client_id TEXT NOT NULL, ip_digest TEXT NOT NULL, expires INTEGER NOT NULL)`);
  db.write('CREATE INDEX IF NOT EXISTS signup_challenges_expiry ON signup_challenges(expires)');
  db.write('CREATE INDEX IF NOT EXISTS signup_challenges_ip ON signup_challenges(ip_digest)');
  db.write(
    'CREATE INDEX IF NOT EXISTS signup_challenges_invite ON signup_challenges(invite_digest)',
  );
  db.write(`CREATE TABLE IF NOT EXISTS access_request_challenges (
    digest TEXT PRIMARY KEY, student_number TEXT NOT NULL, client_id TEXT NOT NULL,
    ip_digest TEXT NOT NULL, expires INTEGER NOT NULL)`);
  db.write(
    'CREATE INDEX IF NOT EXISTS access_challenges_expiry ON access_request_challenges(expires)',
  );
  db.write(
    'CREATE INDEX IF NOT EXISTS access_challenges_ip ON access_request_challenges(ip_digest)',
  );
  db.write(
    'CREATE INDEX IF NOT EXISTS access_challenges_student ON access_request_challenges(student_number)',
  );
  db.write(`CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY, student_number TEXT NOT NULL UNIQUE, student_name TEXT NOT NULL,
    year_of_study INTEGER NOT NULL CHECK(year_of_study BETWEEN 1 AND 6),
    phy_team_member INTEGER NOT NULL CHECK(phy_team_member IN (0,1)),
    justification TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.write(`CREATE TABLE IF NOT EXISTS attempts (
    bucket TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL)`);
  db.write('CREATE INDEX IF NOT EXISTS attempts_age ON attempts(started)');
  db.write(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
    questions_visible INTEGER NOT NULL, solutions_visible INTEGER NOT NULL)`);
  db.write(`CREATE TABLE IF NOT EXISTS content (
    id TEXT NOT NULL, part TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (id, part, seq))`);
}

// Split on byte boundaries and decode after joining. An individual lesson can exceed
// SQLite's per-row limit, and a Unicode character can straddle two chunks.
export function storePart(db: Database, id: string, part: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    db.write(
      'INSERT INTO content (id,part,seq,bytes) VALUES (?,?,?,?)',
      id,
      part,
      offset,
      bytes.slice(offset, offset + chunkSize).buffer,
    );
  }
}

export function readPart(db: Database, id: string, part: string): unknown[] {
  const chunks = db.all<{ bytes: ArrayBuffer }>(
    'SELECT bytes FROM content WHERE id=? AND part=? ORDER BY seq',
    id,
    part,
  );
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const json =
    chunks.map((chunk) => decoder.decode(chunk.bytes, { stream: true })).join('') +
    decoder.decode();
  return JSON.parse(json);
}
