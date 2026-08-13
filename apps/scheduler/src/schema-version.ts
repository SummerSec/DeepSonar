/**
 * The only schema version this Scheduler will run against.
 *
 * Empty databases are bootstrapped from database/schema.sql.
 * Non-empty databases must already be at this version; there is no upgrade path.
 * Schema changes: edit schema.sql, bump this constant, rebuild the database.
 */
export const SCHEMA_VERSION = 30;
