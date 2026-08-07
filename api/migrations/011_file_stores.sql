-- Where a test's files live, so the API under test can fetch them.
--
-- A campaign's recipients.files takes URLs or minio bucket/keys. The author uploads a file
-- and copies what comes back, so the reference is a literal in the test from then on --
-- nothing at run time reads this table, and the execution engine does not know it exists.
--
-- Scoped to a project and NAMED, not scoped to an environment. An earlier design keyed a
-- store by environment name, by analogy with baseUrl, which bought nothing: uploading
-- happens while authoring, so which environment is selected has no bearing on the result.
-- What it cost was the ability to have two stores at once -- and having two is the point,
-- because migrating from minio to a file-service pod means running both for a while.
--
-- CASCADE is right here, unlike the run history: a store definition is part of the project
-- and describes nothing once the project is gone.
--
-- secret_key and token are write-only above this layer. The API accepts them and never
-- returns them, so a credential cannot reach the browser through a project fetch.
CREATE TABLE IF NOT EXISTS file_stores (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  bucket TEXT,
  prefix TEXT NOT NULL DEFAULT '',
  access_key TEXT,
  secret_key TEXT,
  token TEXT,
  reference TEXT NOT NULL DEFAULT 'key',
  region TEXT NOT NULL DEFAULT 'us-east-1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Two stores called the same thing in one project cannot be told apart in a picker, and the
-- picker is the whole interface for switching between them.
CREATE UNIQUE INDEX IF NOT EXISTS file_stores_project_name
  ON file_stores (project_id, name COLLATE NOCASE);
