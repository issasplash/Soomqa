# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository contains no source code, build configuration, tests, or documentation at this time. The working tree is empty apart from this file. There is nothing to document about commands, architecture, or conventions until code is added.

Before assuming anything about the stack, layout, or tooling, inspect the working tree — do not infer from the repository name or prior commit messages.

## What to replace this file with

Once the project has real content, rewrite this file to cover:

1. **Commands** — the actual build, lint, type-check, and test invocations used by the project, including how to run a single test.
2. **Architecture** — the big-picture structure that requires reading multiple files to understand: entry points, module boundaries, data flow, key abstractions, and external service integrations.
3. **Conventions** — non-obvious patterns a new contributor would otherwise learn by trial and error: error handling style, testing patterns, naming, deployment quirks, and any project-specific rules from README, `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md`.
