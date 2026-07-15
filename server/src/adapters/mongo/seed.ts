// Default identity values — kept as named exports so existing tests and the
// standalone seed script (db/scripts/seed-db.ts) can import them as fixture
// constants without hardcoding strings.
//
// The boot-time upsert path (the old SeedModelOps / createDomainSeeder) has
// been removed: sale and product data now lives in MongoDB and is provisioned
// once via db/scripts/seed-db.ts rather than overwritten on every server boot.
// Bootstrap reads the active sale via adapters/mongo/sale-bootstrap.ts.
export const SALE_SLUG = "flash-sale";
export const SALE_NAME = "Flash Sale";
export const PRODUCT_SKU = "KEYCAP-ONE";
export const PRODUCT_NAME = "Keycap One";
export const PRODUCT_ORIGINAL_PRICE = 199.99;
export const PRODUCT_FLASH_SALE_PRICE = 99.99;
