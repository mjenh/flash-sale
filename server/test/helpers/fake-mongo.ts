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
  /** Ready-made bootstrap override: `mongoModelOps: fakeMongo.ops`. */
  ops: { audit: AuditModelOps; seed: SeedModelOps };
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

    async upsertSale(slug, { startTime, endTime, stockQuantity }): Promise<string> {
      const existing = fake.sales.get(slug);
      if (existing !== undefined) {
        // $set semantics: the durable record mirrors current env config.
        existing.startTime = startTime;
        existing.endTime = endTime;
        existing.stockQuantity = stockQuantity;
        return existing.id;
      }
      const saleId = id("sale");
      fake.sales.set(slug, { id: saleId, startTime, endTime, stockQuantity });
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

  fake.ops = { audit: fake.audit, seed: fake.seed };
  return fake;
}
