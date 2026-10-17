# trash2review — holding pen, not a deletion

Files here were moved out of the working tree by the cleanup pipeline because
they looked redundant, orphaned, or superseded. Nothing is deleted automatically.

Every file keeps its original relative path under this folder:

    trash2review/src/ai/foo.ts   ← was   src/ai/foo.ts

## Restore one

    git mv trash2review/src/ai/foo.ts src/ai/foo.ts

## Empty the folder

After reviewing, either restore files individually as above, or `git rm -r`
the ones you confirm are dead. Nothing outside this folder depends on files
inside it — if the tests pass with the folder gone, everything in it was
safe to drop.
