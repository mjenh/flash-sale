// Shared in-memory fake of the Mongo MODEL-OPS layer (AuditModelOps +
// SaleBootstrapOps + CatalogModelOps). Endpoint tests inject these into
// bootstrap() so the REAL createOrderRecorder / createCatalogReader
// compositions run over them — only the one-query-per-op mongoose calls are
// faked, mirroring fake-redis.
//
// Why fakes and not mongodb-memory-server: the MongoDB binary CDN
// (fastdl.mongodb.org) is blocked in this environment, and it would be a new
// dependency outside the architecture stack. Compose-run Mongo validation is
// deferred to the compose-run harness, same as Redis.
//
// Fidelity notes: insertConfirmedOrder enforces the (saleId, email) unique
// index by rejecting with `code: 11000` (the real Mongo duplicate-key shape);
// inventories honor $setOnInsert semantics (never overwrites);
// listConfirmedOrderEmails filters by saleId AND status like the real query.
import type { AuditModelOps } from "../../src/adapters/mongo/audit.ts";
import type { SaleBootstrapOps } from "../../src/adapters/mongo/sale-bootstrap.ts";
import type { CatalogModelOps } from "../../src/adapters/mongo/catalog.ts";
import {
  SALE_NAME,
  PRODUCT_SKU,
  PRODUCT_NAME,
  PRODUCT_ORIGINAL_PRICE,
  PRODUCT_FLASH_SALE_PRICE,
} from "../../src/adapters/mongo/seed.ts";
import { START_MS, END_MS } from "./time-fixtures.ts";

interface FakeOrderDoc {
  id: string;
  saleId: string;
  email: string;
  userId: string;
  status: string;
}

interface FakeOrderLineDoc {
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: number; // snapshot of flashSalePrice at acceptance time
}

interface FakeSaleDoc {
  id: string;
  name: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

export interface FakeMongo {
  users: Map<string, string>; // identifier -> userId
  products: Map<string, { id: string; name: string; originalPrice: number }>; // sku -> doc
  sales: Map<string, FakeSaleDoc>; // slug -> doc
  saleProducts: Map<string, number>; // `${saleId}:${productId}` -> flashSalePrice
  inventories: Map<string, number>; // productId -> initialQuantity
  orders: FakeOrderDoc[];
  orderLines: FakeOrderLineDoc[];
  /** When true, every AUDIT write rejects (the accept path only). */
  failingAudit: boolean;
  audit: AuditModelOps;
  saleBootstrap: SaleBootstrapOps;
  catalog: CatalogModelOps;
  /** Ready-made bootstrap override: `mongoModelOps: fakeMongo.ops`. */
  ops: { audit: AuditModelOps; saleBootstrap: SaleBootstrapOps; catalog: CatalogModelOps };
}

export function createFakeMongo(): FakeMongo {
  let nextId = 0;
  const id = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  const fake: FakeMongo = {
    users: new Map(),
    products: new Map(),
    sales: new Map(),
    saleProducts: new Map(),
    inventories: new Map(),
    orders: [],
    orderLines: [],
    failingAudit: false,
    audit: undefined as unknown as AuditModelOps,
    saleBootstrap: undefined as unknown as SaleBootstrapOps,
    catalog: undefined as unknown as CatalogModelOps,
    ops: undefined as unknown as FakeMongo["ops"],
  };

  const assertAuditUp = (): void => {
    if (fake.failingAudit) {
      throw new Error("MongoServerSelectionError: connection lost");
    }
  };

  fake.audit = {
    async upsertUser(identifier: string): Promise<string> {
      assertAuditUp();
      const existing = fake.users.get(identifier);
      if (existing !== undefined) {
        return existing;
      }
      const userId = id("user");
      fake.users.set(identifier, userId);
      return userId;
    },

    async insertConfirmedOrder(doc): Promise<string> {
      assertAuditUp();
      if (fake.orders.some((o) => o.saleId === doc.saleId && o.email === doc.email)) {
        // The real unique-index rejection shape (E11000).
        throw Object.assign(new Error("E11000 duplicate key error collection: flash-sale.orders"), {
          code: 11000,
        });
      }
      const orderId = id("order");
      fake.orders.push({ id: orderId, ...doc, status: "confirmed" });
      return orderId;
    },

    async insertOrderLine(doc): Promise<void> {
      assertAuditUp();
      fake.orderLines.push({ ...doc });
    },
  };

  // SaleBootstrapOps — three read-only queries that mirror mongoSaleBootstrapOps
  // over the same in-memory maps that reserveSaleId / addCatalogProduct populate.
  fake.saleBootstrap = {
    async listAllSales() {
      return [...fake.sales.entries()].map(([slug, doc]) => ({
        _id: doc.id,
        slug,
        name: doc.name,
        startTime: doc.startTime,
        endTime: doc.endTime,
        stockQuantity: doc.stockQuantity,
      }));
    },

    async getSaleProduct(saleId: string) {
      const prefix = `${saleId}:`;
      for (const [key, flashSalePrice] of fake.saleProducts.entries()) {
        if (key.startsWith(prefix)) {
          return { productId: key.slice(prefix.length), flashSalePrice };
        }
      }
      return null;
    },

    async listConfirmedOrderEmails(saleId: string) {
      return [
        ...new Set(
          fake.orders.filter((o) => o.saleId === saleId && o.status === "confirmed").map((o) => o.email),
        ),
      ];
    },
  };

  // Sale -> SaleProduct -> Product -> Inventory join, mirroring
  // mongoCatalogModelOps's three one-query-per-op shape over the same
  // products/saleProducts/inventories maps reserveSaleId/addCatalogProduct populate.
  fake.catalog = {
    async listSaleProducts(saleId: string) {
      const prefix = `${saleId}:`;
      return [...fake.saleProducts.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, flashSalePrice]) => ({
          productId: key.slice(prefix.length),
          flashSalePrice,
        }));
    },

    async listProductsByIds(productIds: string[]) {
      const idSet = new Set(productIds);
      return [...fake.products.entries()]
        .filter(([, product]) => idSet.has(product.id))
        .map(([sku, product]) => ({
          id: product.id,
          sku,
          name: product.name,
          originalPrice: product.originalPrice,
        }));
    },

    async listInventoriesByProductIds(productIds: string[]) {
      const idSet = new Set(productIds);
      return [...fake.inventories.entries()]
        .filter(([productId]) => idSet.has(productId))
        .map(([productId, initialQuantity]) => ({ productId, initialQuantity }));
    },
  };

  fake.ops = { audit: fake.audit, saleBootstrap: fake.saleBootstrap, catalog: fake.catalog };
  return fake;
}

/** Test fixture helper: adds a product to a sale's catalog via direct map
 *  operations (mirroring the real upsert semantics), so catalog join tests can
 *  exercise a multi-product sale without hand-rolling map entries that could
 *  drift from the real upsert behavior. */
export async function addCatalogProduct(
  mongo: FakeMongo,
  saleId: string,
  product: {
    sku: string;
    name: string;
    initialQuantity: number;
    originalPrice?: number;
    flashSalePrice?: number;
  },
): Promise<string> {
  // upsertProduct semantics: update originalPrice if exists, insert if not.
  const existing = mongo.products.get(product.sku);
  let productId: string;
  if (existing !== undefined) {
    existing.originalPrice = product.originalPrice ?? 0;
    existing.name = product.name;
    productId = existing.id;
  } else {
    productId = `product-${product.sku.toLowerCase()}`;
    mongo.products.set(product.sku, {
      id: productId,
      name: product.name,
      originalPrice: product.originalPrice ?? 0,
    });
  }
  // upsertSaleProduct: set or overwrite flashSalePrice.
  mongo.saleProducts.set(`${saleId}:${productId}`, product.flashSalePrice ?? 0);
  // upsertInventory: $setOnInsert — never overwrite.
  if (!mongo.inventories.has(productId)) {
    mongo.inventories.set(productId, product.initialQuantity);
  }
  return productId;
}

/**
 * Test seam: reserves a deterministic saleId for the given slug and
 * pre-seeds the associated Product / SaleProduct / Inventory so that
 * bootstrap()'s getSaleProduct(saleId) returns real data at boot.
 *
 *  Timing defaults to the time-fixtures constants (START_MS / END_MS, ~1970).
 *  Tests that use 2026-era clocks MUST pass { startMs, endMs } explicitly —
 *  otherwise bootstrap selects the sale as "most-recently-ended" and order
 *  requests return 409 inactive.
 *
 *  Idempotent by slug: calling again with the same mongo returns the same
 *  saleId. Mutable fields (startTime, endTime, stockQuantity) are updated if
 *  the corresponding opts are explicitly provided (mirrors $set semantics). */
export async function reserveSaleId(
  mongo: FakeMongo,
  slug: string,
  opts?: {
    startMs?: number;
    endMs?: number;
    stockQuantity?: number;
    flashSalePrice?: number;
  },
): Promise<string> {
  const startMs = opts?.startMs ?? START_MS;
  const endMs = opts?.endMs ?? END_MS;
  const stockQuantity = opts?.stockQuantity ?? 100;
  const flashSalePrice = opts?.flashSalePrice ?? PRODUCT_FLASH_SALE_PRICE;

  let saleId: string;
  const existingSale = mongo.sales.get(slug);
  if (existingSale !== undefined) {
    // $set semantics for explicitly provided fields only.
    if (opts?.startMs !== undefined) existingSale.startTime = new Date(startMs);
    if (opts?.endMs !== undefined) existingSale.endTime = new Date(endMs);
    if (opts?.stockQuantity !== undefined) existingSale.stockQuantity = stockQuantity;
    saleId = existingSale.id;
  } else {
    saleId = `sale-${slug}`;
    mongo.sales.set(slug, {
      id: saleId,
      name: SALE_NAME,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      stockQuantity,
    });
  }

  // Seed the default product (KEYCAP-ONE) if not yet present.
  let productId: string;
  const existingProduct = mongo.products.get(PRODUCT_SKU);
  if (existingProduct !== undefined) {
    productId = existingProduct.id;
  } else {
    productId = `product-${PRODUCT_SKU.toLowerCase()}`;
    mongo.products.set(PRODUCT_SKU, {
      id: productId,
      name: PRODUCT_NAME,
      originalPrice: PRODUCT_ORIGINAL_PRICE,
    });
  }

  // Seed saleProduct (overwrite flashSalePrice if opts provided).
  const spKey = `${saleId}:${productId}`;
  if (!mongo.saleProducts.has(spKey) || opts?.flashSalePrice !== undefined) {
    mongo.saleProducts.set(spKey, flashSalePrice);
  }

  // Seed inventory ($setOnInsert — never overwrite).
  if (!mongo.inventories.has(productId)) {
    mongo.inventories.set(productId, stockQuantity);
  }

  return saleId;
}
