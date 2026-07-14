// Shared in-memory fake of the Mongo MODEL-OPS layer (AuditModelOps +
// SeedModelOps). Endpoint tests inject these into bootstrap() so the REAL
// createOrderRecorder / createDomainSeeder compositions run over them —
// only the one-query-per-op mongoose calls are faked, mirroring fake-redis.
//
// Why fakes and not mongodb-memory-server: the MongoDB binary CDN
// (fastdl.mongodb.org) is blocked in this environment, and it would be a new
// dependency outside the architecture stack. Compose-run Mongo validation is
// deferred to the compose-run harness, same as Redis.
//
// Fidelity notes: insertConfirmedOrder enforces the (saleId, email) unique
// index by rejecting with `code: 11000` (the real Mongo duplicate-key shape);
// upsertInventory honors $setOnInsert semantics (never overwrites);
// listConfirmedOrderEmails filters by saleId AND status like the real query.
import type { AuditModelOps } from "../../src/adapters/mongo/audit.ts";
import type { SeedModelOps } from "../../src/adapters/mongo/seed.ts";
import type { CatalogModelOps } from "../../src/adapters/mongo/catalog.ts";

export interface FakeOrderDoc {
  id: string;
  saleId: string;
  email: string;
  userId: string;
  status: string;
}

export interface FakeOrderLineDoc {
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface FakeSaleDoc {
  id: string;
  name: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

export interface FakeMongo {
  users: Map<string, string>; // identifier -> userId
  products: Map<string, { id: string; name: string }>; // sku -> doc
  sales: Map<string, FakeSaleDoc>; // slug -> doc
  saleProducts: Set<string>; // `${saleId}:${productId}`
  inventories: Map<string, number>; // productId -> initialQuantity
  orders: FakeOrderDoc[];
  orderLines: FakeOrderLineDoc[];
  /** When true, every AUDIT write rejects (the accept path only). */
  failingAudit: boolean;
  audit: AuditModelOps;
  seed: SeedModelOps;
  catalog: CatalogModelOps;
  /** Ready-made bootstrap override: `mongoModelOps: fakeMongo.ops`. */
  ops: { audit: AuditModelOps; seed: SeedModelOps; catalog: CatalogModelOps };
}

export function createFakeMongo(): FakeMongo {
  let nextId = 0;
  const id = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  const fake: FakeMongo = {
    users: new Map(),
    products: new Map(),
    sales: new Map(),
    saleProducts: new Set(),
    inventories: new Map(),
    orders: [],
    orderLines: [],
    failingAudit: false,
    audit: undefined as unknown as AuditModelOps,
    seed: undefined as unknown as SeedModelOps,
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

  fake.seed = {
    async upsertProduct(sku: string, name: string): Promise<string> {
      const existing = fake.products.get(sku);
      if (existing !== undefined) {
        return existing.id;
      }
      const productId = id("product");
      fake.products.set(sku, { id: productId, name });
      return productId;
    },

    async upsertSale(slug, { name, startTime, endTime, stockQuantity }): Promise<string> {
      const existing = fake.sales.get(slug);
      if (existing !== undefined) {
        // $set semantics: the durable record mirrors current env config.
        existing.name = name;
        existing.startTime = startTime;
        existing.endTime = endTime;
        existing.stockQuantity = stockQuantity;
        return existing.id;
      }
      const saleId = id("sale");
      fake.sales.set(slug, { id: saleId, name, startTime, endTime, stockQuantity });
      return saleId;
    },

    async upsertSaleProduct(saleId: string, productId: string): Promise<void> {
      fake.saleProducts.add(`${saleId}:${productId}`);
    },

    async upsertInventory(productId: string, initialQuantity: number): Promise<void> {
      // $setOnInsert semantics: seeded once, never overwritten or ticked.
      if (!fake.inventories.has(productId)) {
        fake.inventories.set(productId, initialQuantity);
      }
    },

    async listConfirmedOrderEmails(saleId: string): Promise<string[]> {
      return [
        ...new Set(
          fake.orders.filter((o) => o.saleId === saleId && o.status === "confirmed").map((o) => o.email),
        ),
      ];
    },
  };

  // Story 4.3: Sale -> SaleProduct -> Product -> Inventory join, mirroring
  // mongoCatalogModelOps's three one-query-per-op shape over the same
  // products/saleProducts/inventories maps the seeder above populates.
  fake.catalog = {
    async listSaleProducts(saleId: string) {
      const prefix = `${saleId}:`;
      return [...fake.saleProducts]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ productId: key.slice(prefix.length) }));
    },

    async listProductsByIds(productIds: string[]) {
      const idSet = new Set(productIds);
      return [...fake.products.entries()]
        .filter(([, product]) => idSet.has(product.id))
        .map(([sku, product]) => ({ id: product.id, sku, name: product.name }));
    },

    async listInventoriesByProductIds(productIds: string[]) {
      const idSet = new Set(productIds);
      return [...fake.inventories.entries()]
        .filter(([productId]) => idSet.has(productId))
        .map(([productId, initialQuantity]) => ({ productId, initialQuantity }));
    },
  };

  fake.ops = { audit: fake.audit, seed: fake.seed, catalog: fake.catalog };
  return fake;
}

/** Test fixture helper: adds a second product to a sale's catalog beyond the
 *  single boot-seeded one, via the same real seed ops the production seeder
 *  uses (upsertProduct -> upsertSaleProduct -> upsertInventory), so catalog
 *  join tests can exercise a multi-product sale without hand-rolling map
 *  entries that could drift from the real upsert semantics. */
export async function addCatalogProduct(
  mongo: FakeMongo,
  saleId: string,
  product: { sku: string; name: string; initialQuantity: number },
): Promise<string> {
  const productId = await mongo.seed.upsertProduct(product.sku, product.name);
  await mongo.seed.upsertSaleProduct(saleId, productId);
  await mongo.seed.upsertInventory(productId, product.initialQuantity);
  return productId;
}

/** Story 4.2 test seam: Redis keys/channel are namespaced by the resolved
 *  sale's Mongo ObjectId string, but that id is only known once the REAL
 *  bootstrap() seeder runs. Endpoint tests that need to pre-seed a fake
 *  Redis with a scoped `stock:{saleId}:remaining` key (simulating a warm
 *  boot) must know the id BEFORE calling bootstrap(). Since upsertSale is
 *  idempotent by slug ($set semantics — see fake.seed.upsertSale above),
 *  reserving the id here and letting the real seeder's later upsertSale call
 *  land on the same doc is safe and keeps the fake and the production seeder
 *  in lockstep. */
export async function reserveSaleId(mongo: FakeMongo, slug: string): Promise<string> {
  return mongo.seed.upsertSale(slug, {
    name: "",
    startTime: new Date(0),
    endTime: new Date(0),
    stockQuantity: 0,
  });
}
