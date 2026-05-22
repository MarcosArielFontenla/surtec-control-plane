---
name: architecture-review
description: Use to review architecture boundaries, dependencies, scalability, maintainability, and replacement paths.
---

# Skill: Architecture Review

## Objective

Evaluate whether a system design is understandable, bounded, maintainable, and aligned with current needs.

## When To Use

- Reviewing a proposed architecture, adapter boundary, service split, dependency, or major refactor.

## Procedure

1. Identify components, responsibilities, and interfaces.
2. Trace data flow and control flow.
3. Review coupling, dependency direction, replacement paths, and failure modes.
4. Flag overbuilding, under-specification, and unclear ownership.
5. Recommend the smallest useful adjustment.

## Output Format

- Architecture summary.
- Component responsibilities.
- Dependency risks.
- Scalability and maintainability concerns.
- Recommended changes.
- Decision points.

## Limits

- Do not propose unrelated rewrites.
- Do not add abstraction unless it reduces real complexity.

