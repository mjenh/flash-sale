// The reset contract, proven with fakes: the guard fires BEFORE any write, the
// write sequence is exact, and the seed collections are never touched.
import { describe, expect, it } from "vitest";
import { ApiStillServingError, resetAll, WIPED_COLLECTIONS, type ResetPorts } from "../reset.ts";

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
        writes.push(`SET stock:remaining ${value}`);
      },
      deleteOrderUsers: async () => {
        writes.push("DEL orders:users");
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

    await expect(resetAll(ports, 100)).rejects.toBeInstanceOf(ApiStillServingError);
    expect(writes).toEqual([]);
  });

  it("treats a 503 as still serving — a Redis-down API can still come back mid-reset", async () => {
    const { ports, writes } = recorder("HTTP 503 from http://localhost:3000/api/sale/status");

    await expect(resetAll(ports, 100)).rejects.toBeInstanceOf(ApiStillServingError);
    expect(writes).toEqual([]);
  });

  it("performs the exact reset contract, in order, when the API is stopped", async () => {
    const { ports, writes } = recorder(null);

    const result = await resetAll(ports, 100);

    // Wipe first, sentinel last: stock:remaining is written only after every
    // wipe, so a crash mid-reset leaves no sentinel beside a stale orders:users set.
    expect(writes).toEqual([
      "DEL orders:users",
      "deleteMany orders",
      "deleteMany orderlines",
      "deleteMany users",
      "SET stock:remaining 100",
    ]);
    expect(result).toEqual({
      stockQuantity: 100,
      cleared: ["orders:users", "orders", "orderlines", "users"],
    });
  });

  it("never touches the seed collections (they are re-upserted at boot)", async () => {
    const { ports, writes } = recorder(null);

    await resetAll(ports, 100);

    for (const seed of ["products", "sales", "saleproducts", "inventories"]) {
      expect(writes).not.toContain(`deleteMany ${seed}`);
      expect(WIPED_COLLECTIONS).not.toContain(seed);
    }
  });

  it("seeds the configured stock quantity, not a hard-coded 100", async () => {
    const { ports, writes } = recorder(null);

    await resetAll(ports, 7);

    // The sentinel is the last write, not the first.
    expect(writes.at(-1)).toBe("SET stock:remaining 7");
  });
});
