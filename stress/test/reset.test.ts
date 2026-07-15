// The reset contract, proven with fakes: the guard fires BEFORE any write, the
// write sequence is exact, and the seed collections are never touched.
//
// Keys are namespaced by saleId — the fake ports below log the exact
// namespaced key names, not the retired v1.0 flat keys.
import { describe, expect, it } from "vitest";
import {
  ApiStillServingError,
  ordersKeyFor,
  resetAll,
  stockKeyFor,
  WIPED_COLLECTIONS,
  type ResetPorts,
} from "../reset.ts";

const SALE_ID = "sale-abc123";

interface Recorder {
  ports: ResetPorts;
  writes: string[];
}

function recorder(probe: string | null): Recorder {
  const writes: string[] = [];
  return {
    writes,
    ports: {
      probeApi: async () => probe,
      setStock: async (value) => {
        writes.push(`SET ${stockKeyFor(SALE_ID)} ${value}`);
      },
      deleteOrderUsers: async () => {
        writes.push(`DEL ${ordersKeyFor(SALE_ID)}`);
      },
      deleteCollection: async (name) => {
        writes.push(`deleteMany ${name}`);
      },
    },
  };
}

describe("resetAll", () => {
  it("aborts before any write when the API answers", async () => {
    const { ports, writes } = recorder("HTTP 200 from http://localhost:3000/api/sale/status");

    await expect(resetAll(ports, 100, SALE_ID)).rejects.toBeInstanceOf(ApiStillServingError);
    expect(writes).toEqual([]);
  });

  it("treats a 503 as still serving — a Redis-down API can still come back mid-reset", async () => {
    const { ports, writes } = recorder("HTTP 503 from http://localhost:3000/api/sale/status");

    await expect(resetAll(ports, 100, SALE_ID)).rejects.toBeInstanceOf(ApiStillServingError);
    expect(writes).toEqual([]);
  });

  it("performs the exact reset contract, in order, when the API is stopped", async () => {
    const { ports, writes } = recorder(null);

    const result = await resetAll(ports, 100, SALE_ID);

    // Wipe first, sentinel last: stock:{saleId}:remaining is written only
    // after every wipe, so a crash mid-reset leaves no sentinel beside a
    // stale orders:{saleId}:users set.
    expect(writes).toEqual([
      `DEL ${ordersKeyFor(SALE_ID)}`,
      "deleteMany orders",
      "deleteMany orderlines",
      "deleteMany users",
      `SET ${stockKeyFor(SALE_ID)} 100`,
    ]);
    expect(result).toEqual({
      stockQuantity: 100,
      cleared: [ordersKeyFor(SALE_ID), "orders", "orderlines", "users"],
      saleId: SALE_ID,
    });
  });

  it("never touches the seed collections (they are re-upserted at boot)", async () => {
    const { ports, writes } = recorder(null);

    await resetAll(ports, 100, SALE_ID);

    for (const seed of ["products", "sales", "saleproducts", "inventories"]) {
      expect(writes).not.toContain(`deleteMany ${seed}`);
      expect(WIPED_COLLECTIONS).not.toContain(seed);
    }
  });

  it("seeds the configured stock quantity, not a hard-coded 100", async () => {
    const { ports, writes } = recorder(null);

    await resetAll(ports, 7, SALE_ID);

    // The sentinel is the last write, not the first.
    expect(writes.at(-1)).toBe(`SET ${stockKeyFor(SALE_ID)} 7`);
  });

  it("a different saleId targets different namespaced keys in the result", async () => {
    const { ports } = recorder(null);

    const result = await resetAll(ports, 100, "other-sale");

    expect(result.cleared[0]).toBe(ordersKeyFor("other-sale"));
    expect(result.saleId).toBe("other-sale");
  });

  it("no longer references the v1.0 flat keys anywhere in the reset contract", async () => {
    const { ports } = recorder(null);

    const result = await resetAll(ports, 100, SALE_ID);

    for (const key of result.cleared) {
      expect(key).not.toBe("stock:remaining");
      expect(key).not.toBe("orders:users");
    }
    expect(stockKeyFor(SALE_ID)).not.toBe("stock:remaining");
    expect(ordersKeyFor(SALE_ID)).not.toBe("orders:users");
  });
});
