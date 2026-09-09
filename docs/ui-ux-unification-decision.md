# UI/UX unification decision

- Date: 2026-09-08
- Decision: adopt the complete interface and interaction contract from
  `.docs/PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md`.
- Operator choice: full unification, including compatible API and persisted
  presentation-setting changes.
- Data boundary: encrypted entries, immutable revisions and audit data are not
  migrated or rewritten.
- Compatibility: the former `appearance=dark|light` value remains readable by
  older backups, but the unified interface uses a black surface, a persisted
  accent, sidebar mode and persisted navigation/section order.
- Rollback: restore the previous application files; the added settings rows are
  ignored by older versions and do not alter secret ciphertext.

The new Volt product icon supplied in `volt/.src` is used as the service asset.
