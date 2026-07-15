#!/usr/bin/env node
// Idempotent DB provisioner — reads JSON arrays from db/data/ and upserts
// each document into the corresponding MongoDB collection.
//
// Usage:
//   node db/scripts/seed-db.ts [options]
//
// Options:
//   --mongoUri  MongoDB connection string
//               (default: $MONGODB_URI or mongodb://localhost:27017/flash-sale)
//   --dataDir   Directory containing the JSON seed files
//               (default: db/data relative to cwd)
//
// Data files (each a JSON array):
//   products.json     — { sku, name, originalPrice }
//   sales.json        — { slug, name, startTime, endTime, stockQuantity }
//   saleproducts.json — { saleSlug, productSku, flashSalePrice }
//                         (saleSlug / productSku are resolved to ObjectIds)
//   inventories.json  — { productSku, initialQuantity }
//                         (productSku is resolved to ObjectId)
//
// Upsert semantics:
//   products      — filter: sku;          $set: name, originalPrice
//   sales         — filter: slug;         $set: name, startTime, endTime, stockQuantity
//   saleproducts  — filter: saleId+productId; $set: flashSalePrice
//   inventories   — filter: productId;    $setOnInsert: initialQuantity (never overwritten)
//
// Exit codes:  0 = success · 1 = bad args or connection error
import fs from "node:fs";
import path from "node:path";
import mongoose, { type Types } from "mongoose";

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        result[key] = value;
        i++;
      }
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

const mongoUri =
  args["mongoUri"] ??
  process.env["MONGODB_URI"] ??
  "mongodb://localhost:27017/flash-sale";

const dataDir = path.resolve(
  process.cwd(),
  args["dataDir"] ?? "db/data",
);

// ── JSON file helpers ─────────────────────────────────────────────────────────

function readJson<T>(filename: string): T[] {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[seed-db] WARN: ${filePath} not found — skipping`);
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array`);
  }
  return parsed as T[];
}

// ── Mongoose models (inline — db/scripts/ must not import from server/src/) ──

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    originalPrice: { type: Number, required: true },
  },
  { timestamps: true },
);
const Product = mongoose.model("Product", productSchema, "products");

const saleSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    stockQuantity: { type: Number, required: true },
  },
  { timestamps: true },
);
const Sale = mongoose.model("Sale", saleSchema, "sales");

const saleProductSchema = new mongoose.Schema(
  {
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    flashSalePrice: { type: Number, required: true },
  },
  { timestamps: true },
);
saleProductSchema.index({ saleId: 1, productId: 1 }, { unique: true });
const SaleProduct = mongoose.model("SaleProduct", saleProductSchema, "saleproducts");

const inventorySchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    initialQuantity: { type: Number, required: true },
  },
  { timestamps: true },
);
const Inventory = mongoose.model("Inventory", inventorySchema, "inventories");

// ── Seed logic ────────────────────────────────────────────────────────────────

interface ProductRow {
  sku: string;
  name: string;
  originalPrice: number;
}

interface SaleRow {
  slug: string;
  name: string;
  startTime: string;
  endTime: string;
  stockQuantity: number;
}

interface SaleProductRow {
  saleSlug: string;
  productSku: string;
  flashSalePrice: number;
}

interface InventoryRow {
  productSku: string;
  initialQuantity: number;
}

async function seed(): Promise<void> {
  console.log(`[seed-db] data dir : ${dataDir}`);
  console.log(`[seed-db] mongo    : ${mongoUri.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log();

  // ── Read all JSON files up-front so a missing/malformed file fails before
  //    we open a Mongo connection.
  const productRows = readJson<ProductRow>("products.json");
  const saleRows = readJson<SaleRow>("sales.json");
  const saleProductRows = readJson<SaleProductRow>("saleproducts.json");
  const inventoryRows = readJson<InventoryRow>("inventories.json");

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log("[seed-db] Connected.\n");

  // ── 1. Products ─────────────────────────────────────────────────────────────
  const productIdBySku = new Map<string, Types.ObjectId>();

  for (const row of productRows) {
    const doc = await Product.findOneAndUpdate(
      { sku: row.sku },
      { $set: { name: row.name, originalPrice: row.originalPrice } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    const id = doc!._id as Types.ObjectId;
    productIdBySku.set(row.sku, id);
    console.log(`[seed-db] product  : ${row.sku} → ${String(id)}`);
  }

  // ── 2. Sales ────────────────────────────────────────────────────────────────
  const saleIdBySlug = new Map<string, Types.ObjectId>();

  for (const row of saleRows) {
    const startTime = new Date(row.startTime);
    const endTime = new Date(row.endTime);
    if (isNaN(startTime.getTime())) {
      throw new Error(`sales.json: invalid startTime "${row.startTime}" for slug "${row.slug}"`);
    }
    if (isNaN(endTime.getTime())) {
      throw new Error(`sales.json: invalid endTime "${row.endTime}" for slug "${row.slug}"`);
    }
    if (endTime <= startTime) {
      throw new Error(`sales.json: endTime must be after startTime for slug "${row.slug}"`);
    }
    const doc = await Sale.findOneAndUpdate(
      { slug: row.slug },
      { $set: { name: row.name, startTime, endTime, stockQuantity: row.stockQuantity } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    const id = doc!._id as Types.ObjectId;
    saleIdBySlug.set(row.slug, id);
    console.log(`[seed-db] sale     : ${row.slug} → ${String(id)}`);
  }

  // ── 3. SaleProducts (resolve symbolic refs) ─────────────────────────────────
  for (const row of saleProductRows) {
    const saleId = saleIdBySlug.get(row.saleSlug);
    if (saleId === undefined) {
      throw new Error(
        `saleproducts.json: saleSlug "${row.saleSlug}" not found in sales.json`,
      );
    }
    const productId = productIdBySku.get(row.productSku);
    if (productId === undefined) {
      throw new Error(
        `saleproducts.json: productSku "${row.productSku}" not found in products.json`,
      );
    }
    await SaleProduct.findOneAndUpdate(
      { saleId, productId },
      { $set: { flashSalePrice: row.flashSalePrice } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(
      `[seed-db] saleproduct: ${row.saleSlug}+${row.productSku} flashSalePrice=${row.flashSalePrice}`,
    );
  }

  // ── 4. Inventories (resolve symbolic refs; $setOnInsert — never overwrite) ──
  for (const row of inventoryRows) {
    const productId = productIdBySku.get(row.productSku);
    if (productId === undefined) {
      throw new Error(
        `inventories.json: productSku "${row.productSku}" not found in products.json`,
      );
    }
    await Inventory.findOneAndUpdate(
      { productId },
      { $setOnInsert: { initialQuantity: row.initialQuantity } },
      { upsert: true, new: true },
    );
    console.log(
      `[seed-db] inventory  : ${row.productSku} initialQuantity=${row.initialQuantity} (setOnInsert)`,
    );
  }

  console.log("\n[seed-db] Done ✓");
}

seed()
  .then(() => {
    void mongoose.disconnect();
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("\n[seed-db] FATAL:", err);
    void mongoose.disconnect();
    process.exit(1);
  });
