# Minimal Web Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a locally hosted web console with access-key login and only Chat Memory and Skill management pages.

**Architecture:** Keep the existing Node modular monolith as the only process. Protect every `/v1/*` domain endpoint with one configured access key, expose a login verification endpoint, and serve a Vite-built React single-page application from the same origin. The browser stores the accepted key locally and supplies it as a Bearer token; the first milestone deliberately has one local administrator and no registration, teams, or role model.

**Tech Stack:** Node.js 22, TypeScript, React 18, React Router, Vite, Node test runner, React Testing Library, SQLite.

---

### Task 1: Access-key authentication

**Files:**
- Create: `src/auth/access-key.ts`
- Modify: `src/api/http-server.ts`
- Modify: `src/server.ts`
- Test: `tests/http-auth.test.ts`

1. Write failing HTTP tests for login success, login rejection, missing Bearer token, and accepted Bearer token.
2. Run the focused test and confirm it fails because authentication is not implemented.
3. Add constant-time access-key verification and protect `/v1/*` except `/v1/auth/login`.
4. Pass the configured key from `MEMORY_SKILLS_ACCESS_KEY`; refuse to start without it.
5. Run the focused test and the existing backend suite.

### Task 2: Browser client and authenticated shell

**Files:**
- Create: `web/package.json`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/lib/api.ts`
- Create: `web/src/lib/session.ts`
- Test: `web/src/App.test.tsx`

1. Write a failing UI test proving an unauthenticated visitor sees the access-key form and a valid login opens the console.
2. Implement the minimal API client, local session storage, logout, and two-route shell.
3. Run the UI test until green.

### Task 3: Chat Memory page

**Files:**
- Create: `web/src/pages/MemoryPage.tsx`
- Create: `web/src/components/StatusBadge.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/pages/MemoryPage.test.tsx`

1. Write failing tests for list rendering, search, draft creation, and lifecycle action wiring.
2. Implement a scope-aware list/detail layout using the existing memory API.
3. Add a small create-memory flow that first captures evidence and then creates a Draft.
4. Run the focused tests until green.

### Task 4: Skill page

**Files:**
- Create: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/pages/SkillsPage.test.tsx`

1. Write failing tests for list/detail rendering and Draft Skill creation.
2. Implement list, keyword filtering, detail view, create, and status transitions using the existing Skill API.
3. Run the focused tests until green.

### Task 5: Visual system and same-origin delivery

**Files:**
- Create: `web/src/styles.css`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Modify: `src/api/http-server.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/static-web.test.ts`

1. Write a failing server test for `/` and SPA fallback delivery.
2. Implement safe static asset serving from `web/dist`.
3. Add restrained dark operations-console styling derived from the original Memory Hub visual direction.
4. Add root install/build/dev commands and document login setup.
5. Run backend tests, frontend tests, type checks, production builds, and a real login/browser smoke test.

