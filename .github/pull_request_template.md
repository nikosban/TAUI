## Linear issue

Link the Linear issue this pull request completes.

## Summary

Describe the user-visible or engineering outcome.

## Verification

List the focused commands and manual checks run. Link hosted CI when available.

## Regression-test sabotage (bug fixes)

- Regression test:
- Exact sabotage used to reproduce the bug or invalidate the fix:
- Command and expected failure excerpt:
- Passing command after restoring the fix:

Use `N/A — not a bug fix` only when this pull request does not fix a defect. Never
commit sabotaged code. The failure must exercise the reported regression, not an
unrelated syntax, setup, or assertion error.

## Manual release and security impact

- Release-checklist areas affected:
- Parser, adapter, dependency, or Tauri-permission review:
- Manual failure Linear issue(s), or `None`:
