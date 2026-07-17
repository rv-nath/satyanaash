# Test Groups Implementation Plan (Plan 2 of 3)

> **For agentic workers:** implement task-by-task; each task ends with a build/test gate and a commit.

**Goal:** Organize test cases into single-level, user-created groups shown as a collapsible tree in the rail, backed by a `test_groups` table.

**Architecture:** Backend approach **B** — a `test_groups` table plus a nullable `group_id` FK on `test_cases` (`ON DELETE SET NULL`). "Ungrouped" is the virtual bucket for `group_id IS NULL` — no real row, hidden when empty. New groups sort to the top via `created_at DESC`. Frontend fetches groups + test cases and renders the grouped tree, with create/rename/delete/move.

**Tech Stack:** Backend Rust (Axum + SQLx AnyPool, raw SQL, repository trait pattern). Frontend React + TanStack Query + shadcn.

**Spec:** `docs/superpowers/specs/2026-07-17-ux-flow-test-workspace-redesign.md` §7 (incl. validated group UX).

## Global Constraints

- Single level only (no nested groups). `Ungrouped` = `group_id IS NULL`, hidden when empty, never deletable.
- New groups appear at the **top** (order `created_at DESC`).
- Deleting a group sets its tests' `group_id` to NULL (fall back to Ungrouped), never deletes tests.
- Follow existing patterns exactly: raw SQL with `?` binds, `AnyPool`, repository trait + Sqlx impl, `.with_state(repo)` route group, RFC3339 timestamps as strings.
- Backend: `cd api && cargo build && cargo test` green before each backend commit. Frontend: `cd gui-lov && npm test && npm run build` green before each frontend commit.
- Commit after each task. Prefixes `feat:`/`fix:`/`chore:`.

## File Structure

**Backend (`api/`):**
- Create `migrations/007_test_groups.sql` — table + `group_id` column.
- Modify `src/db/pool.rs` — register migration 007.
- Modify `src/db/models.rs` — `TestGroup`, `CreateTestGroup`, `UpdateTestGroup`; add `group_id` to `TestCase`/`CreateTestCase`/`UpdateTestCase`.
- Modify `src/db/repositories/mod.rs` — `TestGroupRepository` trait + `pub use`.
- Create `src/db/repositories/test_groups.rs` — `SqlxTestGroupRepository`.
- Modify `src/db/repositories/test_cases.rs` — read/write `group_id`.
- Create `src/api/groups.rs` — CRUD handlers.
- Modify `src/api/mod.rs` — `pub mod groups;`.
- Modify `src/main.rs` — build `SqlxTestGroupRepository`, group routes.

**Frontend (`gui-lov/`):**
- Modify `src/lib/api/types.ts` — `TestGroup`; `group_id` on `TestCase`.
- Modify `src/lib/api/endpoints.ts` — group endpoints.
- Modify `src/hooks/useApi.ts` — `useTestGroups`, `useCreateGroup`, `useRenameGroup`, `useDeleteGroup`; thread `group_id` through test-case create/update.
- Modify `src/components/TestInventory.tsx` — grouped tree rendering + interactions.

---

## Task 1 — Migration 007 (table + column)

**Files:** create `api/migrations/007_test_groups.sql`; modify `api/src/db/pool.rs`.

- [ ] **Step 1** — Create `api/migrations/007_test_groups.sql`:
```sql
-- Test groups: single-level, user-created buckets for organizing test cases (idempotent-friendly)
CREATE TABLE IF NOT EXISTS test_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- Nullable group_id on test_cases; NULL = Ungrouped
ALTER TABLE test_cases ADD COLUMN group_id TEXT;
```
(No FK constraint — SQLite via AnyPool doesn't reliably enforce ADD COLUMN FKs; deletion nulling is handled in the repository. The `duplicate column` guard in pool.rs makes re-runs safe.)

- [ ] **Step 2** — Register in `api/src/db/pool.rs` migrations array, after `006_add_pre_test_script.sql`:
```rust
include_str!("../../migrations/007_test_groups.sql"),
```

- [ ] **Step 3** — Build + run: `cd api && cargo build` then `cargo run` briefly (or a test) to confirm migrations apply without error (the duplicate-column guard tolerates re-runs). Expected: server starts, no migration error.

- [ ] **Step 4** — Commit: `feat: add test_groups migration (table + group_id column)`

---

## Task 2 — Models

**Files:** modify `api/src/db/models.rs`.

- [ ] **Step 1** — Add group models near `TestCase`:
```rust
/// Test group entity (single-level bucket)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateTestGroup { pub name: String }

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTestGroup { pub name: String }
```

- [ ] **Step 2** — Add `group_id` to the three test-case structs:
  - `TestCase`: after `project_id` add
    ```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    ```
  - `CreateTestCase`: add `#[serde(default)] pub group_id: Option<String>,`
  - `UpdateTestCase`: add `#[serde(default)] pub group_id: Option<String>,`

- [ ] **Step 3** — `cargo build` (will fail until repo updated in Task 3/…): expected compile errors only in `test_cases.rs` for the new field. That's fine — proceed; the gate is at Task 3's end.

- [ ] **Step 4** — Commit with Task 3 (models + repos build together).

---

## Task 3 — Repositories (test_groups + test_cases group_id)

**Files:** modify `api/src/db/repositories/mod.rs`, `test_cases.rs`; create `test_groups.rs`.

**Interfaces produced:**
```rust
#[async_trait]
pub trait TestGroupRepository: Send + Sync {
    async fn create(&self, project_id: &str, input: CreateTestGroup) -> Result<TestGroup, AppError>;
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<TestGroup>, AppError>;
    async fn update(&self, id: &str, input: UpdateTestGroup) -> Result<TestGroup, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>; // nulls group_id on its test_cases
}
```

- [ ] **Step 1** — In `mod.rs`: add `mod test_groups;`, `pub use test_groups::SqlxTestGroupRepository;`, and the trait above.

- [ ] **Step 2** — Create `test_groups.rs` (mirror `test_cases.rs` style). `list_by_project` orders `created_at DESC`. `delete` runs `UPDATE test_cases SET group_id = NULL WHERE group_id = ?` then `DELETE FROM test_groups WHERE id = ?`. Include an inline `#[cfg(test)]` unit test that creates a sqlite `:memory:` pool, applies the schema, creates two groups, and asserts `list_by_project` returns newest-first. (Pattern: other repos' tests, if any; otherwise a focused async test with `AnyPoolOptions`.)

- [ ] **Step 3** — In `test_cases.rs`: add `group_id` to INSERT columns/binds, SELECT lists (get/list), UPDATE (`group_id = ?` with `input.group_id.or(existing.group_id)`), the two `TestCase {…}` constructors, and `row_to_test_case` (`group_id: row.try_get("group_id")?`).

- [ ] **Step 4** — Gate: `cd api && cargo build && cargo test`. Expected: PASS incl. the new group test.

- [ ] **Step 5** — Commit: `feat: add test group model + repository; group_id on test cases`

---

## Task 4 — API handlers + routes

**Files:** create `api/src/api/groups.rs`; modify `api/src/api/mod.rs`, `api/src/main.rs`.

- [ ] **Step 1** — `groups.rs` handlers (mirror `test_cases.rs`): `create_group` (POST `/api/v1/projects/{project_id}/groups`), `list_groups` (GET same), `update_group` (PATCH `/api/v1/groups/{id}`), `delete_group` (DELETE `/api/v1/groups/{id}`), each `State(repo): State<Arc<dyn TestGroupRepository>>`.

- [ ] **Step 2** — `api/mod.rs`: add `pub mod groups;`.

- [ ] **Step 3** — `main.rs`: `let test_group_repo = Arc::new(SqlxTestGroupRepository::new(pool.clone()));` and a `group_routes` Router with the four routes + `.with_state(test_group_repo.clone())`, merged into `app`. Import `SqlxTestGroupRepository`.

- [ ] **Step 4** — Gate: `cargo build`, then `cargo run` and curl-smoke: create a group, list groups, rename, delete; and create a test case with `group_id`. Expected: 201/200/204 as appropriate.

- [ ] **Step 5** — Commit: `feat: add test group CRUD API + routes`

---

## Task 5 — Frontend API layer

**Files:** modify `gui-lov/src/lib/api/types.ts`, `endpoints.ts`, `src/hooks/useApi.ts`.

- [ ] **Step 1** — `types.ts`: add
  ```ts
  export interface TestGroup { id: string; project_id: string; name: string; created_at: string; updated_at: string; }
  ```
  and `group_id?: string | null;` on `TestCase`.
- [ ] **Step 2** — `endpoints.ts`: group endpoints (list/create under project, patch/delete by id) mirroring test-case endpoints.
- [ ] **Step 3** — `useApi.ts`: `useTestGroups(projectId)`, `useCreateGroup()`, `useRenameGroup()`, `useDeleteGroup()` (invalidate groups + test-cases queries on mutate). Ensure test-case create/update pass `group_id` through.
- [ ] **Step 4** — Gate: `npm run build`. Commit: `feat: add group types, endpoints, and query hooks`

---

## Task 6 — Grouped rail rendering

**Files:** modify `gui-lov/src/components/TestInventory.tsx`.

- [ ] **Step 1** — Fetch groups via `useTestGroups`. Build a map: for each group (newest-first) list its tests (`tc.group_id === group.id`); collect `group_id == null` into a virtual **Ungrouped** bucket rendered **last** and **only if non-empty**.
- [ ] **Step 2** — Render collapsible group headers (caret + name + count + hover `+`) with the test rows nested (reuse `TestRow`). Per-user collapsed state in `localStorage`. Search filters within groups and auto-expands matches (keep existing search).
- [ ] **Step 3** — Gate: `npm test && npm run build`. Commit: `feat: render tests grouped in a collapsible tree`

---

## Task 7 — Group interactions (create / rename / delete / move / create-in-place)

**Files:** modify `gui-lov/src/components/TestInventory.tsx` (+ `TestCaseEditor.tsx` optional Group field).

- [ ] **Step 1** — Folder-plus icon in the TESTS header → inserts an inline "Untitled group" editable row at the **top**; Enter calls `useCreateGroup`, Escape cancels.
- [ ] **Step 2** — Group header `⋮`: Rename (inline) via `useRenameGroup`; Delete via `useDeleteGroup` (confirm; tests fall to Ungrouped).
- [ ] **Step 3** — Test row `⋮` → **Move to group ▸** submenu (all groups, current checked, + "New group…") → PATCH test case `group_id`.
- [ ] **Step 4** — Each group header's hover `+` creates a test already in that group (pass `group_id` to the create flow / open editor pre-set).
- [ ] **Step 5** — Gate: `npm test && npm run build`. Commit: `feat: group create/rename/delete/move + create-in-place`

---

## Self-Review

- Spec §7 coverage: single-level ✓ (T1 no parent col); create/rename/delete ✓ (T3/T4/T7); assign via move-menu ✓ (T7); new-at-top ✓ (created_at DESC, T3); Ungrouped virtual + hidden-when-empty ✓ (T6); create-in-place ✓ (T7). Drag-to-group intentionally deferred. Editor Group field optional (T7 note).
- Deletion safety: group delete nulls `group_id`, never deletes tests (T3 delete).
- Types: `TestGroupRepository` (T3) consumed in T4; `TestGroup`/`group_id` (T5) consumed in T6/T7.
