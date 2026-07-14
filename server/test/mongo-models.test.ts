// Zero I/O: pure mongoose schema inspection, no connection. Pins the
// spine's Mongo conventions: eight collections with exact names, timestamps
// everywhere, the four unique indexes (orders on (saleId, email)), the
// single v1 order status, OrderLine defaults, and Reservation dormancy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Model, Schema } from "mongoose";
import {
  Inventory,
  Order,
  OrderLine,
  Product,
  Reservation,
  Sale,
  SaleProduct,
  User,
} from "../src/adapters/mongo/models.ts";

const allModels: Array<[Model<never> | Model<unknown>, string]> = [
  [User as unknown as Model<unknown>, "users"],
  [Product as unknown as Model<unknown>, "products"],
  [Sale as unknown as Model<unknown>, "sales"],
  [SaleProduct as unknown as Model<unknown>, "saleproducts"],
  [Inventory as unknown as Model<unknown>, "inventories"],
  [Order as unknown as Model<unknown>, "orders"],
  [OrderLine as unknown as Model<unknown>, "orderlines"],
  [Reservation as unknown as Model<unknown>, "reservations"],
];

function hasUniqueIndex(schema: Schema, fields: Record<string, number>): boolean {
  return schema
    .indexes()
    .some(
      ([keys, options]) =>
        JSON.stringify(keys) === JSON.stringify(fields) && options?.unique === true,
    );
}

describe("mongo domain models", () => {
  it("registers all eight models with the exact spine collection names", () => {
    for (const [model, name] of allModels) {
      expect(model.collection.collectionName).toBe(name);
    }
  });

  it("every schema carries timestamps: true", () => {
    for (const [model, name] of allModels) {
      expect(model.schema.get("timestamps"), `${name} timestamps`).toBe(true);
    }
  });

  it("unique index: users.identifier", () => {
    expect(hasUniqueIndex(User.schema, { identifier: 1 })).toBe(true);
  });

  it("unique index: products.sku", () => {
    expect(hasUniqueIndex(Product.schema, { sku: 1 })).toBe(true);
  });

  it("unique compound index: saleproducts (saleId, productId)", () => {
    expect(hasUniqueIndex(SaleProduct.schema, { saleId: 1, productId: 1 })).toBe(true);
  });

  it("unique compound index: orders (saleId, email) — defense-in-depth", () => {
    expect(hasUniqueIndex(Order.schema, { saleId: 1, email: 1 })).toBe(true);
  });

  it("order status is exactly the single v1 value 'confirmed' (enum + default)", () => {
    const status = Order.schema.path("status");
    expect(status.options.enum).toEqual(["confirmed"]);
    expect(status.options.default).toBe("confirmed");
    expect(status.options.required).toBe(true);
  });

  it("order line snapshots default to qty 1 / unitPrice 0", () => {
    expect(OrderLine.schema.path("quantity").options.default).toBe(1);
    expect(OrderLine.schema.path("unitPrice").options.default).toBe(0);
  });

  it("reservation stays dormant: no production write path references it", () => {
    // Source guard (the order-script.test.ts pattern): the only modules that
    // write Mongo are audit.ts and seed.ts — neither may touch Reservation.
    for (const file of ["audit.ts", "seed.ts", "client.ts"]) {
      const source = readFileSync(
        new URL(`../src/adapters/mongo/${file}`, import.meta.url),
        "utf8",
      );
      expect(source.includes("Reservation"), `${file} must not reference Reservation`).toBe(false);
    }
  });
});
