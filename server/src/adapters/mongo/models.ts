// Mongoose domain models — the full v1 schema, persisted now with behavior
// trigger-gated (ARCHITECTURE-SPINE "Domain model"): Product/Sale/SaleProduct/
// Inventory are boot-seeded; Inventory is never ticked per order; Reservation
// is defined-but-dormant (never written by any code path). MongoDB is the
// durable audit record, never the concurrency mechanism (AD-3).
//
// Collection names are explicit (third arg) and match the spine exactly.
// Unique indexes: users.identifier, products.sku, saleproducts (saleId,
// productId), orders (saleId, email) — email per PRD Amendment B.
// Mongoose `timestamps: true` throughout.
import mongoose, { Schema, type Types } from "mongoose";

export interface UserDoc {
  /** Trusted identifier — the email (PRD Amendment B). */
  identifier: string;
}

const userSchema = new Schema<UserDoc>(
  { identifier: { type: String, required: true, unique: true } },
  { timestamps: true },
);

export const User = mongoose.model<UserDoc>("User", userSchema, "users");

export interface ProductDoc {
  sku: string;
  name: string;
}

const productSchema = new Schema<ProductDoc>(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);

export const Product = mongoose.model<ProductDoc>("Product", productSchema, "products");

export interface SaleDoc {
  /** Stable single-sale identity — the system has exactly one Flash Sale. */
  slug: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

const saleSchema = new Schema<SaleDoc>(
  {
    slug: { type: String, required: true, unique: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    stockQuantity: { type: Number, required: true },
  },
  { timestamps: true },
);

export const Sale = mongoose.model<SaleDoc>("Sale", saleSchema, "sales");

export interface SaleProductDoc {
  saleId: Types.ObjectId;
  productId: Types.ObjectId;
}

const saleProductSchema = new Schema<SaleProductDoc>(
  {
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  },
  { timestamps: true },
);
saleProductSchema.index({ saleId: 1, productId: 1 }, { unique: true });

export const SaleProduct = mongoose.model<SaleProductDoc>(
  "SaleProduct",
  saleProductSchema,
  "saleproducts",
);

export interface InventoryDoc {
  productId: Types.ObjectId;
  /** Seeded from STOCK_QUANTITY at boot; NEVER ticked per order (trigger-gated). */
  initialQuantity: number;
}

const inventorySchema = new Schema<InventoryDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    initialQuantity: { type: Number, required: true },
  },
  { timestamps: true },
);

export const Inventory = mongoose.model<InventoryDoc>("Inventory", inventorySchema, "inventories");

export interface OrderDoc {
  saleId: Types.ObjectId;
  /** The wire identifier (Amendment B) — also the AD-4 rebuild source. */
  email: string;
  userId: Types.ObjectId;
  /** 'confirmed' is the only v1 value (lifecycle states are target-scale). */
  status: "confirmed";
}

const orderSchema = new Schema<OrderDoc>(
  {
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true },
    email: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["confirmed"], default: "confirmed", required: true },
  },
  { timestamps: true },
);
// Defense-in-depth (AD-3): Redis is the decision layer; this index only
// guards the audit trail against anomalous duplicate recording.
orderSchema.index({ saleId: 1, email: 1 }, { unique: true });

export const Order = mongoose.model<OrderDoc>("Order", orderSchema, "orders");

export interface OrderLineDoc {
  orderId: Types.ObjectId;
  productId: Types.ObjectId;
  quantity: number;
  /** Price snapshot — 0 while payment is out of scope (AD-10). */
  unitPrice: number;
}

const orderLineSchema = new Schema<OrderLineDoc>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: { type: Number, required: true, default: 1 },
    unitPrice: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export const OrderLine = mongoose.model<OrderLineDoc>("OrderLine", orderLineSchema, "orderlines");

export interface ReservationDoc {
  saleId: Types.ObjectId;
  productId: Types.ObjectId;
  email: string;
  status: string;
  expiresAt: Date;
}

// Dormant by design (spine "Domain model"): schema ships in v1, no code path
// ever writes it. Activates only at the reserve->confirm payment trigger.
const reservationSchema = new Schema<ReservationDoc>(
  {
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    email: { type: String, required: true },
    status: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const Reservation = mongoose.model<ReservationDoc>(
  "Reservation",
  reservationSchema,
  "reservations",
);
