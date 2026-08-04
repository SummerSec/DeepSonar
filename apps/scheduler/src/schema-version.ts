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

/** SHA-256 of the normalized public catalog for the checked-in v12 baseline. */
export const TRUSTED_V12_CATALOG_SHA256 =
  "2f90a18f3831017ac81ddac6fc13282d2081db220507efb51fc1400222aaf063";

/** SHA-256 of the normalized public catalog for the checked-in v13 baseline. */
export const TRUSTED_V13_CATALOG_SHA256 =
  "09fc2da5c8508305c497340dc2d6b7169597230cabde639c5793eb99da597825";

/** Versioned normalized-catalog pins used before and after every migration. */
export const TRUSTED_CATALOG_SHA256_BY_VERSION: Readonly<Record<number, string>> = {
  [SUPPORTED_BASELINE_VERSION]: TRUSTED_V12_CATALOG_SHA256,
  [SCHEMA_VERSION]: TRUSTED_V13_CATALOG_SHA256,
};
