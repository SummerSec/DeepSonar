/**
 * The latest schema that this Scheduler knows how to run.
 *
 * v12 is the first supported upgrade source.  Keep the source version
 * explicit: accepting an arbitrary older database would make a migration
 * chain look complete when it is not.
 */
export const SCHEMA_VERSION = 13;
export const SUPPORTED_BASELINE_VERSION = 12;
export const FIRST_MIGRATION_VERSION = SUPPORTED_BASELINE_VERSION + 1;

/** SHA-256 of database/fixtures/schema-v12.sql (raw UTF-8 bytes). */
export const TRUSTED_V12_BASELINE_SHA256 =
  "e2f969374219ccb0bfb88cb96dbdd1825f7e796d2da276d31940687944b9e33a";
