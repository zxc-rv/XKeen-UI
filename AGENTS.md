# Agent Guide for XKeen UI

This document defines the project architecture, development conventions, and guidelines for AI coding agents.

## Project Overview

XKeen UI is a web-based management interface and extension for XKeen, designed for Keenetic/Netcraze routers.

- Managing the XKeen service.
- Managing Xray-core and Mihomo configurations.
- Configuration validation, backups, and templates.
- Managing application and core updates.

### Tech Stack

**Frontend**
- React
- TypeScript
- Bun
- Vite
- Tailwind CSS
- shadcn/ui

**Backend**
- Tokio
- Axum

### Supported Architectures

- `aarch64`
- `mips32`
- `mips32le`

The application targets resource-constrained routers running KeeneticOS/Entware on Linux. Keep runtime resource usage and binary size in mind.

## Development Guidelines

### General Principles

- Follow the existing project architecture and coding patterns.
- Inspect existing implementations before introducing new abstractions or utilities.
- Prefer native, official, and recommended APIs and approaches.
- Avoid unnecessary complexity, duplicated logic, and premature abstractions.
- Keep changes focused and avoid modifying unrelated code.
- Do not reinvent existing functionality when a suitable solution is already available.

### Frontend

- Prefer existing shadcn/ui components when implementing UI elements.
- Follow the established component structure and styling conventions.
- Maintain consistent spacing, typography, colors, and visual hierarchy.
- Ensure components are responsive and accessible.
- Handle loading, empty, success, and error states appropriately.
- Use monospace fonts only for editors, logs, and code snippets (JSON/YAML), not regular UI elements.
- Use tailwind css classes, avoid using any inline styles if possible.
- Avoid introducing custom components when an existing shadcn/ui component can fulfill the requirement.

### Backend

- Prefer Tokio-compatible asynchronous APIs.
- Avoid blocking operations inside asynchronous execution contexts.
- Handle errors explicitly; avoid unnecessary `unwrap()` and `expect()` in runtime code.
- Validate external input before processing it.
- Keep API behavior consistent with existing endpoints and response formats.

### Dependencies

- Check existing dependencies before adding new ones.
- Prefer established libraries over custom implementations when they meaningfully reduce boilerplate or maintenance.
- Avoid unnecessarily heavy dependencies, especially in the router-targeted backend.
- Consider compatibility with all supported architectures and build targets.

## Development Workflow

Before implementing changes:

1. Inspect the relevant source code and existing implementation.
2. Identify reusable components, utilities, and dependencies.
3. Understand the impact on both frontend and backend when applicable.
4. Implement the smallest reasonable change.

After implementing changes:

1. Run relevant formatting, linting, and type checks.
2. Run tests related to the modified functionality.
3. Verify that the frontend/backend builds successfully when applicable.
4. Check compatibility with supported target architectures when backend build behavior is affected.

Do not claim that a check passed unless it was actually executed successfully.

## Build & Validation Commands

Run commands from the corresponding project directory.

### Frontend

Working directory: `frontend/`

```bash
bun i
bun run build
bunx prettier .
```

- `bun run build` — TypeScript type checking and Vite production build.
- `bunx prettier .` — formatting.

### Backend

Working directory: `backend/`

```bash
cargo +nightly fmt --all
cargo +nightly clippy --all-targets -- -D warnings
cargo +nightly test
cargo +nightly build --release
```

- `cargo +nightly clippy --all-targets -- -D warnings` — run Clippy across all targets and treat warnings as errors.
- `cargo +nightly build --release` — build the optimized backend binary.

## Agent Skills

- Project-specific agent skills are located in `.agents/skills/`.
- Read the relevant skill instructions before performing tasks covered by them.
- Do not load unrelated skills.
