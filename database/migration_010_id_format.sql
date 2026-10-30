-- ============================================================
-- Migration 010: Backfill registration_number to ABC-YYYY-NNNNNN format
-- ============================================================
-- Purpose:
--   Converts any bare integer registration numbers (e.g. "1", "42") that
--   were created before the new format was introduced into the standard
--   ABC-YYYY-NNNNNN format (e.g. "ABC-2024-000001").
--
-- Safety:
--   Idempotent — the WHERE clause filters to rows that do NOT already
--   start with 'ABC-' and ARE purely numeric, so running this migration
--   multiple times will never corrupt already-formatted values.
--
-- Year source:
--   Uses date_registered when available; falls back to created_at if
--   date_registered is NULL.
-- ============================================================

UPDATE patients
SET registration_number = CONCAT(
    'ABC-',
    YEAR(COALESCE(date_registered, created_at)),
    '-',
    LPAD(CAST(registration_number AS UNSIGNED), 6, '0')
)
WHERE registration_number NOT LIKE 'ABC-%'
  AND registration_number REGEXP '^[0-9]+$';
