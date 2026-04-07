# GitOps

## Branch Model

- `main`: stable, releasable branch
- `dev`: active integration branch

## Workflow

1. branch from `dev`
2. make one focused change
3. test locally
4. merge back into `dev`
5. promote tested milestones from `dev` to `main`

## Naming

Suggested branch prefixes:

- `feat/...`
- `fix/...`
- `chore/...`
- `notes/...`

Examples:

- `feat/hover-controller`
- `feat/track-generator`
- `fix/checkpoint-respawn`

## Rules

- keep branches short-lived
- avoid bundling unrelated systems in one branch
- merge to `main` only after browser verification
- use small commits with clear messages

## First Repo State

Current local branches:

- `main`
- `dev`

The initial commit still needs to be created before branch refs are fully anchored.
