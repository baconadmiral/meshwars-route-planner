# Repository Guidelines

## Project Structure & Module Organization

This project is a MeshWars wardriving route planner. Its goal is to find routes between a start and destination that increase expected square captures within a driving budget. The repository currently contains planning documentation; application code and tooling have not been selected.

Keep project scope and setup instructions in `README.md`. When implementation begins, separate routing, square scoring, and external data adapters into focused modules. Put automated tests in `tests/` and sample, non-sensitive datasets in `tests/fixtures/`. Existing hidden directories contain environment metadata and are not application source.

## Build, Test, and Development Commands

No build, development, lint, or test commands are configured yet. Add exact commands to `README.md` when introducing the application stack. Do not document commands as working until they have been run successfully.

## Coding Style & Naming Conventions

Use the selected language's standard formatter and consistent indentation. Prefer descriptive names such as `capture_probability`, `detour_budget`, and `visited_squares`, adapted to the language's naming conventions. Include units in ambiguous values, such as `distance_meters` and `duration_seconds`.

Keep protocol-specific capture rules separate from route optimization. Preserve coordinate reference systems and grid identifiers explicitly; approximate grid cells must not be presented as official MeshWars squares.

## Testing Guidelines

No framework or coverage threshold is established. Test route endpoints, budget enforcement, duplicate-square handling, unavailable coverage, and unreachable destinations. Use deterministic fixtures for optimization tests. Mock external services in routine tests and label live integration checks separately.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so an existing commit convention cannot be verified. Use focused commits with imperative subjects, such as `Add detour budget validation`.

Pull requests should describe the resulting behavior, reference relevant issues, and report validation performed. Include screenshots for map or interface changes and explain changes to scoring assumptions.

## Security & Data Handling

Keep API keys and personal location histories out of version control. Use placeholder configuration examples. Identify data sources and their freshness, and distinguish estimated captures from confirmed game results.
