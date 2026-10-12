# v1.1.2

- Save Unified / Side-by-Side diff mode in the local dsh profile, shared by Changes, Log and turn review.
- Restore the choice after desktop restart even when the local server port changes; migrate the previous browser preference when available.
- Serialize rapid switches and preserve new clicks while the stored choice is loading.
- Capture each actual agent turn before execution and freeze its result when it ends; select previous rounds from Review, with local history that survives restart.
- Show one file header when a diff expands, retaining view controls, collapse and revert actions without repeating the path.
- Verified profile persistence across host restart and port changes, validation, migration and initialization races.
- Verified independent rounds, exclusion of pre-existing edits, frozen historical results, read-only history and snapshot retention across Git GC.

## Previous: v1.1.1

- Fix the composer layout regression: the turn-review chip no longer stretches across the page.
- Review alone has a composer-sized row; with gitbar, both controls share the same row.
- Optional composition follows slot declaration/disposal and supports either plugin load order.
- All standalone Git and review capabilities from v1.1.0 remain available.
