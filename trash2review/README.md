# trash2review

Holding pen for files the cleanup pipeline flagged as redundant — **nothing here is deleted**.

Files arrive via `git mv`, so history is preserved. Review each file and either:

- restore it: `git mv trash2review/<path> <original/path>` (original path is mirrored), or
- approve removal: delete it here and `git commit`.

Nothing in this directory is referenced by the build.
